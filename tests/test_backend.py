import os
import base64
import copy
import importlib.machinery
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch, MagicMock

backend = Path(__file__).resolve().parents[1] / 'root/usr/libexec/singbox-gui'
loader = importlib.machinery.SourceFileLoader('backend', str(backend))
spec = importlib.util.spec_from_loader(loader.name, loader)
b = importlib.util.module_from_spec(spec)
loader.exec_module(b)
UUID = '12345678-1234-5678-9234-567812345678'
BASE = 'vless://' + UUID + '@192.0.2.1:443'
S = dict(interface='sbvpn', device='sb-tun0', uplink='eth0', source_zone='lan',
         address='172.30.255.1/30', mtu='1400', dns='https://1.1.1.1/dns-query',
         bootstrap_dns='1.1.1.1', dns_detour='proxy', dns_mode='external')


class BackendTests(unittest.TestCase):
    def test_routing_worker_spawn_failure_allows_retry(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(b, 'RUN', Path(directory)), patch.object(b.subprocess, 'Popen', side_effect=[OSError('fork failed'), MagicMock()]):
            args = dict(mode='check', text=json.dumps(b.routing.defaults()))
            with self.assertRaises(OSError):
                b.routing_job('routing_start', args)
            self.assertEqual(list((b.RUN / 'routing-jobs').glob('*.json')), [])
            self.assertTrue(b.routing_job('routing_start', args)['ok'])

    def test_existing_tun_does_not_prove_service_is_running(self):
        stopped = json.dumps({'singbox-gui': {'instances': {'main': {'running': False}}}})
        running = json.dumps({'singbox-gui': {'instances': {'main': {'running': True}}}})
        with patch.object(b, 'run', side_effect=[stopped, running]) as command, patch.object(Path, 'exists', return_value=True), patch.object(b.time, 'sleep'):
            b.wait_service('test-tun')
            self.assertEqual(command.call_count, 2)
        with patch.object(b, 'run', return_value=stopped), patch.object(Path, 'exists', return_value=True), patch.object(b.time, 'sleep'):
            with self.assertRaises(ValueError):
                b.wait_service('test-tun')

    def setUp(self):
        # Never inherit the live router routing profile or subscription store.
        store = tempfile.TemporaryDirectory()
        self.addCleanup(store.cleanup)
        isolated = patch.object(b, 'STORE', Path(store.name))
        isolated.start()
        self.addCleanup(isolated.stop)
        if os.environ.get('SINGBOX_TEST_BINARY'):
            core = patch.object(b, 'core_binary', return_value=os.environ['SINGBOX_TEST_BINARY'])
            core.start()
            self.addCleanup(core.stop)

    def test_primary_dns_ignores_unused_external_settings(self):
        cfg = b.config(dict(S, dns_mode='https_dns_proxy', dns='',
                            bootstrap_dns='invalid', dns_detour='invalid'), None, with_routing=False)
        self.assertEqual(cfg['dns']['final'], 'router-dns')
        self.assertEqual(cfg['dns']['servers'][0]['server'], '127.0.0.1')
        self.assertEqual(cfg['outbounds'][0]['domain_resolver'], 'router-dns')

    def test_external_dns_accepts_bare_ipv6_and_rejects_invalid_authority(self):
        cfg = b.config(dict(S, dns='2001:4860:4860::8888'), None, with_routing=False)
        self.assertEqual(cfg['dns']['servers'][1]['server'], '2001:4860:4860::8888')
        for value in ('https://:password@example.test/dns-query', 'udp://1.1.1.1:0'):
            with self.subTest(value=value), self.assertRaises(ValueError):
                b.config(dict(S, dns=value), None, with_routing=False)

    def test_concurrent_subscription_downloads_own_their_headers(self):
        barrier = threading.Barrier(2)
        paths = []
        def download(command, **kwargs):
            headers = Path(command[command.index('--dump-header') + 1])
            target = Path(command[command.index('--output') + 1])
            paths.append(headers)
            limited = command[-1].endswith('/limited')
            headers.write_text('x-hwid-limit: true\n' if limited else 'HTTP/2 200\n')
            target.write_text(BASE)
            barrier.wait(timeout=5)
            return subprocess.CompletedProcess(command, 0, stdout='', stderr='')
        def fetch(path):
            try:
                return b.fetch_subscription('https://example.test/' + path, dict(subscription_user_agent='Test/1'))
            except ValueError as error:
                return str(error)
        with tempfile.TemporaryDirectory() as directory, patch.object(b, 'RUN', Path(directory)), patch.object(b.subprocess, 'run', side_effect=download):
            with ThreadPoolExecutor(max_workers=2) as pool:
                limited, valid = list(pool.map(fetch, ['limited', 'valid']))
            self.assertEqual(len(set(paths)), 2)
            self.assertIn('device limit', limited)
            self.assertEqual(valid, BASE)
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_probe_dns_retries_truncated_response_over_tcp(self):
        tcp = []
        class Socket:
            def __init__(self, family, kind, *args):
                self.kind, self.query, self.buffer = kind, b'', b''
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def settimeout(self, value): pass
            def setsockopt(self, *args): pass
            def connect(self, address): self.address = address
            def send(self, query): self.query = query
            def sendall(self, query):
                self.query = query[2:]; tcp.append(self.address)
                reply = self.response(False)
                self.buffer = b.struct.pack('!H', len(reply)) + reply
            def response(self, truncated):
                kind = b.struct.unpack('!H', self.query[-4:-2])[0]
                answer = kind == 1 and not truncated
                flags = 0x8380 if truncated else 0x8180
                header = self.query[:2] + b.struct.pack('!5H', flags, 1, int(answer), 0, 0)
                data = b'\xc0\x0c' + b.struct.pack('!2HIH', 1, 1, 60, 4) + bytes([203, 0, 113, 7]) if answer else b''
                return header + self.query[12:] + data
            def recv(self, count):
                if self.kind == b.socket.SOCK_DGRAM:
                    kind = b.struct.unpack('!H', self.query[-4:-2])[0]
                    return self.response(kind == 1)
                data, self.buffer = self.buffer[:count], self.buffer[count:]
                return data
        with patch.object(b.socket, 'socket', side_effect=Socket):
            result = b.probe_resolve('large.example', '1.1.1.1', 'eth0')
        self.assertEqual(result, ['203.0.113.7'])
        self.assertEqual(tcp, [('1.1.1.1', 53)])

    def test_probe_tries_ipv6_despite_many_ipv4_answers(self):
        fake = MagicMock(); fake.__enter__.return_value = fake
        attempted = []
        def connect(target):
            attempted.append(target[0])
            if ':' not in target[0]: raise b.socket.timeout()
        fake.connect.side_effect = connect
        addresses = ['192.0.2.' + str(index) for index in range(1, 6)] + ['2001:db8::1']
        with patch.object(b.socket, 'socket', return_value=fake):
            result = b.probe_server(('dual.example', 443), tcp_only=True, addresses=addresses)
        self.assertEqual(attempted, ['192.0.2.1', '2001:db8::1'])
        self.assertIsNotNone(result['tcp_ms'])

    def test_one_failed_probe_does_not_discard_other_nodes(self):
        first = b.parse_vless(BASE); second = b.parse_vless(BASE.replace('192.0.2.1', '192.0.2.2'))
        def measure(target, **kwargs):
            if target[0] == '192.0.2.1': raise ValueError('Synthetic per-node error')
            return dict(tcp_ms=2.0, tcp_error=None)
        with tempfile.TemporaryDirectory() as directory, patch.object(b, 'RUN', Path(directory)), patch.object(b, 'load_nodes', return_value=[first, second]), patch.object(b, 'settings', return_value=dict(uplink='eth0')), patch.object(b, 'probe_server', side_effect=measure), patch.object(b, 'probe_resolve', side_effect=lambda server, *args: [server]):
            result = b.latency([first['id'], second['id']])
        self.assertTrue(result['ok'])
        self.assertEqual(result['completed'], 2)
        self.assertEqual(result['latency'][first['id']]['tcp_error'], 'probe_error')
        self.assertEqual(result['latency'][second['id']]['tcp_ms'], 2.0)

    def test_cancel_tolerates_concurrent_temporary_directory_cleanup(self):
        original = b.shutil.rmtree
        def concurrently_removed(path, **kwargs):
            original(path)
            return original(path, **kwargs)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); ident = 'a' * 32
            (root / 'probe-jobs').mkdir()
            b.atomic(root / 'probe-jobs' / (ident + '.json'), dict(ok=True, state='running'))
            (root / ('probe-' + ident + '-url-xyz')).mkdir()
            with patch.object(b, 'RUN', root), patch.object(b.shutil, 'rmtree', side_effect=concurrently_removed):
                self.assertEqual(b.probe_job('probe_cancel', ident)['state'], 'cancelled')
            self.assertTrue((root / 'probe-jobs' / (ident + '.cancel')).exists())
            self.assertEqual(json.loads((root / 'probe-jobs' / (ident + '.json')).read_text())['state'], 'cancelled')

    def test_match_all_does_not_download_ignored_rule_sets(self):
        profile = b.routing.defaults()
        profile['rules'] = [dict(match_all=True, outbound='direct', conditions=dict(geosite=['unused-category']))]
        cfg, required = b.routing.compile_profile(profile, b.config(S, None, with_routing=False), [], S, Path('/tmp'))
        self.assertEqual(required, [])
        self.assertNotIn('rule_set', cfg['route'])

    def test_routing_save_rechecks_nodes_after_preparation(self):
        node = b.parse_vless(BASE)
        with tempfile.TemporaryDirectory() as directory, patch.object(b, 'RUN', Path(directory)), patch.object(b, 'STORE', Path(directory)):
            profile = b.routing.defaults(); profile['final'] = 'node:' + node['id']
            old = dict(b.routing.defaults()); b.atomic(b.STORE / 'routing.json', old)
            initial = (b.STORE / 'routing.json').read_bytes()
            ident = 'b' * 32; folder = b.RUN / 'routing-jobs'; folder.mkdir()
            b.atomic(folder / (ident + '-request.json'), dict(profile=profile, mode='save'))
            def command(*args, **kwargs):
                return '{}' if args[:3] == ('ubus', 'call', 'service') else ''
            with patch.object(b, 'settings', return_value=dict(S, selected='', manual_enabled='0', enabled='1')), patch.object(b, 'load_nodes', side_effect=[[node], []]), patch.object(b, 'run', side_effect=command):
                b.routing_worker(ident)
            result = json.loads((folder / (ident + '.json')).read_text())
            self.assertFalse(result['ok'])
            self.assertIn('missing', result['error'])
            self.assertEqual((b.STORE / 'routing.json').read_bytes(), initial)

    def test_routing_new_defaults_and_automatic_mode(self):
        profile=b.routing.defaults()
        self.assertTrue(profile['enabled']);self.assertEqual(profile['final'],'direct');self.assertNotIn('name',profile)
        profile['capture_mode']='automatic'
        base=b.config(S,None,with_routing=False)
        cfg,_=b.routing.compile_profile(profile,base,[],S,Path('/tmp'))
        self.assertTrue(cfg['inbounds'][0]['auto_route']);self.assertTrue(cfg['inbounds'][0]['auto_redirect'])
        self.assertFalse(cfg['inbounds'][0]['strict_route'])
        self.assertEqual(cfg['inbounds'][0]['stack'],'gvisor')
        self.assertIn('240.0.0.0/4',cfg['inbounds'][0]['route_exclude_address'])
        self.assertIn('0.0.0.0/8',cfg['inbounds'][0]['route_exclude_address'])
        self.assertEqual(cfg['inbounds'][0]['dns_mode'],'hijack')
        primary=dict(S,dns_mode='https_dns_proxy')
        primary_cfg,_=b.routing.compile_profile(profile,b.config(primary,None,with_routing=False),[],primary,Path('/tmp'))
        self.assertEqual(primary_cfg['inbounds'][0]['dns_mode'],'disabled')
        self.assertEqual(primary_cfg['dns']['servers'][0]['server'],'127.0.0.1')
        self.assertTrue(all('routing_mark' not in n for n in cfg['outbounds']))
        self.assertIn('192.168.0.0/16',cfg['inbounds'][0]['route_exclude_address'])
        with tempfile.NamedTemporaryFile(mode='w',suffix='.json') as f:
            json.dump(cfg,f);f.flush()
            checked=subprocess.run([os.environ.get('SINGBOX_TEST_BINARY', '/usr/bin/sing-box'),'check','-c',f.name],capture_output=True,text=True)
            self.assertEqual(checked.returncode,0,checked.stderr)
        with self.assertRaises(ValueError):b.routing.normalize(dict(profile,enabled=False))

    def test_removed_server_alias_migrates_to_explicit_node(self):
        node=b.parse_vless(BASE)
        with tempfile.TemporaryDirectory() as directory,patch.object(b,'STORE',Path(directory)),patch.object(b,'uci',return_value=node['id']):
            b.atomic(b.STORE/'routing.json',dict(name='Old',enabled=True,final='proxy',rules=[dict(outbound='proxy',conditions=dict(domain=['test.example']))]))
            profile=b.routing_load()
            self.assertEqual(profile['final'],'direct');self.assertNotIn('name',profile)
            self.assertEqual(profile['rules'][0]['outbound'],'node:'+node['id'])

    def test_automatic_network_setup_does_not_require_or_modify_pbr(self):
        def lookup(key,default=''):
            return {'network.sbvpn':'interface','network.sbvpn.singbox_gui':'1'}.get(key,default)
        def command(*args,**kwargs):
            return "firewall.lan.name='lan'" if args==('uci','-q','show','firewall') else ''
        with tempfile.TemporaryDirectory() as directory,patch.object(b,'STORE',Path(directory)),patch.object(b,'uci',side_effect=lookup),patch.object(b,'routing_load',return_value=dict(capture_mode='automatic')),patch.object(b,'run',side_effect=command) as calls:
            b.configure_network(S)
            self.assertFalse(any(any('pbr' in str(a) for a in c.args) for c in calls.call_args_list))

    def test_subscription_cannot_remove_server_used_by_active_routing(self):
        with tempfile.TemporaryDirectory() as directory,patch.object(b,'STORE',Path(directory)),patch.object(b,'settings',return_value={}):
            node=b.parse_vless(BASE);other=b.parse_vless(BASE.replace('192.0.2.1','192.0.2.2'))
            b.atomic(b.STORE/'subscriptions.json',[dict(id='one',name='One',url='https://example.org',nodes=[node]),dict(id='two',name='Two',url='',nodes=[other])])
            profile=b.routing.defaults();profile.update(enabled=True,final='node:'+node['id']);b.atomic(b.STORE/'routing.json',profile)
            with patch.object(b,'uci',return_value=other['id']):
                with self.assertRaises(ValueError):b.subscription_action('subscription_delete',dict(id='one'))
            snapshot=(b.STORE/'subscriptions.json').read_bytes()
            with patch.object(b,'fetch_subscription',return_value=BASE.replace('192.0.2.1','192.0.2.3')):
                with self.assertRaises(ValueError):b.subscription_action('subscription_refresh',dict(id='one'))
            self.assertEqual((b.STORE/'subscriptions.json').read_bytes(),snapshot)

    def test_routing_order_regex_outbounds_and_dns_preservation(self):
        first = b.parse_vless(BASE)
        other = b.parse_vless(BASE.replace('192.0.2.1','192.0.2.2'))
        profile = b.routing.defaults(); profile['enabled'] = True
        profile['rules'] = [dict(name='Regex', conditions=dict(domain_regex=[r'^([a-z0-9-]+\.)?example\.com$'], port=['443','8000:9000']), outbound='direct'),
                            dict(name='Block', conditions=dict(ip_is_private=True), outbound='block'),
                            dict(name='Other server', conditions=dict(domain=['other.example']), outbound='node:'+other['id'])]
        base = b.config(dict(S,dns_mode='https_dns_proxy'), first, with_routing=False)
        cfg, required = b.routing.compile_profile(profile, base, [first,other], S, Path('/tmp/routing-test'))
        self.assertEqual(cfg['dns'], base['dns'])
        self.assertEqual(cfg['route']['rules'][0], base['route']['rules'][0])
        self.assertEqual(cfg['route']['rules'][1]['action'],'sniff')
        self.assertEqual(cfg['route']['rules'][2]['outbound'],'direct')
        self.assertEqual(cfg['route']['rules'][3]['action'],'reject')
        self.assertEqual(cfg['outbounds'][-1]['tag'],'route-node-'+other['id'])
        self.assertFalse(cfg['inbounds'][0]['auto_route']);self.assertFalse(cfg['inbounds'][0]['auto_redirect'])
        self.assertEqual(required,[])
        with tempfile.NamedTemporaryFile(mode='w',suffix='.json') as f:
            json.dump(cfg,f);f.flush()
            checked=subprocess.run([os.environ.get('SINGBOX_TEST_BINARY', '/usr/bin/sing-box'),'check','-c',f.name],capture_output=True,text=True)
            self.assertEqual(checked.returncode,0,checked.stderr)
        profile['rules'][0]['conditions']['domain_regex']=['(?=unsupported)']
        cfg,_=b.routing.compile_profile(profile,base,[first,other],S,Path('/tmp/routing-test'))
        with tempfile.NamedTemporaryFile(mode='w',suffix='.json') as f:
            json.dump(cfg,f);f.flush()
            checked=subprocess.run([os.environ.get('SINGBOX_TEST_BINARY', '/usr/bin/sing-box'),'check','-c',f.name],capture_output=True,text=True)
            self.assertNotEqual(checked.returncode,0,'RE2 must reject lookahead')

    def test_geosite_uses_remote_rule_set_and_current_http_client(self):
        node=b.parse_vless(BASE);base=b.config(S,node,with_routing=False)
        profile=b.routing.defaults();profile.update(enabled=True,final='block')
        profile['rules']=[dict(conditions=dict(geosite=['geosite:google','geosite-youtube'],domain_regex=[r'.*\.example$']),outbound='node:'+node['id'],mode='or')]
        cfg,required=b.routing.compile_profile(profile,base,[node],S,Path('/tmp/routing-test'))
        self.assertEqual([s['tag'] for s in required],['geosite-google','geosite-youtube'])
        self.assertNotIn('"geosite":',json.dumps(cfg))
        self.assertNotIn('download_detour',json.dumps(cfg))
        self.assertEqual(cfg['route']['rule_set'][0]['http_client'],dict(detour='direct'))
        self.assertTrue(cfg['experimental']['cache_file']['enabled'])
        self.assertEqual(cfg['route']['rules'][-1]['action'],'reject')
        with tempfile.NamedTemporaryFile(mode='w',suffix='.json') as f:
            json.dump(cfg,f);f.flush()
            checked=subprocess.run([os.environ.get('SINGBOX_TEST_BINARY', '/usr/bin/sing-box'),'check','-c',f.name],capture_output=True,text=True)
            self.assertEqual(checked.returncode,0,checked.stderr)

    def test_routing_validation_and_disabled_profile(self):
        node=b.parse_vless(BASE);base=b.config(S,node,with_routing=False)
        self.assertEqual(b.routing.compile_profile(dict(b.routing.defaults(),enabled=False),base,[node],S,Path('/tmp'))[0],base)
        for condition in (dict(ip_cidr=['not-ip']),dict(port=['65536']),dict(domain_regex=[]),dict(geosite=['../../bad']),dict(rule_set=['undefined'])):
            with self.subTest(condition=condition),self.assertRaises(ValueError):
                b.routing.normalize(dict(rules=[dict(conditions=condition)]))
        with self.assertRaises(ValueError):
            b.routing.normalize(dict(rule_sets=[dict(tag='bad',url='file:///etc/shadow')]))

    def test_routing_apply_failure_restores_profile_and_runtime(self):
        with tempfile.TemporaryDirectory() as directory,patch.object(b,'STORE',Path(directory)),patch.object(b,'RUN',Path(directory)):
            profile=b.routing.defaults(); profile['enabled']=True
            node=b.parse_vless(BASE); settings=dict(S,enabled='1',manual_enabled='0',selected=node['id'])
            folder=b.RUN/'routing-jobs';folder.mkdir();ident='a'*32
            b.atomic(folder/(ident+'-request.json'),dict(mode='apply',profile=profile))
            b.atomic(b.STORE/'routing.json',b.routing.defaults());old=(b.STORE/'routing.json').read_bytes()
            previous = {'inbounds': [{'type': 'tun', 'interface_name': 'previous-tun'}]}
            b.atomic(b.RUN/'config.json', previous)
            attempts=[]
            def command(*args,**kwargs):
                if args[:3]==('ubus','call','service'):return json.dumps({'singbox-gui':{'instances':{'main':{'running':True}}}})
                if args==('/etc/init.d/singbox-gui','restart'):
                    attempts.append(args)
                    if len(attempts)==1:raise ValueError('startup failed')
                    self.assertEqual(json.loads((b.RUN/'recovery.json').read_text()), previous)
                return ''
            with patch.object(b,'settings',return_value=settings),patch.object(b,'load_nodes',return_value=[node]),patch.object(b,'run',side_effect=command),patch.object(b,'generate',return_value=settings),patch.object(b,'uci',return_value='interface'),patch.object(b,'wait_service') as wait:
                b.routing_worker(ident)
            self.assertEqual((b.STORE/'routing.json').read_bytes(),old)
            self.assertEqual(json.loads((b.RUN/'config.json').read_text()),previous)
            wait.assert_called_once_with('previous-tun')
            self.assertFalse((b.RUN/'recovery.json').exists())
            self.assertEqual(len(attempts),2)
            self.assertFalse(json.loads((folder/(ident+'.json')).read_text())['ok'])

    def test_log_levels_with_actual_core(self):
        for level in ('trace','debug','info','warn','error','fatal','panic','disabled'):
            with self.subTest(level=level):
                cfg = b.config(dict(S, log_level=level), b.parse_vless(BASE))
                self.assertEqual(cfg['log']['disabled'], level == 'disabled')
                self.assertEqual(cfg['log']['level'], 'info' if level == 'disabled' else level)
                with tempfile.NamedTemporaryFile(mode='w', suffix='.json') as f:
                    json.dump(cfg, f); f.flush()
                    result = subprocess.run([os.environ.get('SINGBOX_TEST_BINARY', '/usr/bin/sing-box'),'check','-c',f.name], capture_output=True, text=True)
                    self.assertEqual(result.returncode, 0, result.stderr)
        with self.assertRaises(ValueError):
            b.config(dict(S, log_level='invalid'), b.parse_vless(BASE))

    def test_package_language_does_not_restart_service(self):
        with patch.object(b, 'run') as command:
            self.assertTrue(b.dispatch('set_language', dict(language='en'))['ok'])
            self.assertEqual([c.args for c in command.call_args_list], [('uci','set','singbox_gui.main.ui_language=en'), ('uci','commit','singbox_gui')])
        with patch.object(b, 'run') as command:
            with self.assertRaises(ValueError):
                b.dispatch('set_language', dict(language='invalid'))
            command.assert_not_called()

    def test_reregister_hwid_is_per_source_and_rolls_back_on_failure(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(b, 'STORE', Path(directory)), patch.object(b, 'settings', return_value=dict(hwid_enabled='1', hwid='global-id')):
            node = b.parse_vless(BASE)
            b.atomic(b.STORE / 'subscriptions.json', [dict(id='one', name='One', url='https://one.example/sub', nodes=[node]), dict(id='two', name='Two', url='https://two.example/sub', nodes=[node], hwid='other-id')])
            with patch.object(b, 'fetch_subscription', return_value=BASE) as fetch:
                b.subscription_action('subscription_reregister', dict(id='one'))
                new_hwid = fetch.call_args.args[1]['hwid']
                self.assertEqual(str(b.uuid.UUID(new_hwid)), new_hwid)
                self.assertEqual(fetch.call_args.args[1]['hwid_enabled'], '1')
                self.assertEqual(b.load_subscriptions()[0]['hwid'], new_hwid)
                self.assertEqual(b.load_subscriptions()[1]['hwid'], 'other-id')
                b.subscription_action('subscription_refresh', dict(id='one'))
                self.assertEqual(fetch.call_args.args[1]['hwid'], new_hwid)
            snapshot = (b.STORE / 'subscriptions.json').read_bytes()
            with patch.object(b, 'fetch_subscription', side_effect=ValueError('device limit')):
                with self.assertRaises(ValueError):
                    b.subscription_action('subscription_reregister', dict(id='one'))
            self.assertEqual((b.STORE / 'subscriptions.json').read_bytes(), snapshot)

    def test_uplink_choices_use_l3_device_and_exclude_own_tunnel(self):
        items = [dict(interface='wan', device='eth0', l3_device='pppoe-wan', up=True, route=[dict(target='0.0.0.0', mask=0)]),
                 dict(interface='wan6', l3_device='pppoe-wan', up=True),
                 dict(interface='lan', device='br-lan', up=True),
                 dict(interface='sb0', l3_device='sb-tun0', up=True),
                 dict(interface='loopback', device='lo'), dict(interface='missing', up=False)]
        with patch.object(b, 'run', return_value=json.dumps(dict(interface=items))), patch.object(b, 'uci', side_effect=lambda key, default='': default):
            choices = b.dispatch('interfaces', {})['interfaces']
        self.assertEqual(choices[0]['device'], 'pppoe-wan')
        self.assertEqual(choices[0]['names'], ['wan', 'wan6'])
        self.assertTrue(choices[0]['default_route'])
        self.assertEqual(len(choices), 2)

    def test_default_subscription_and_automatic_names(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(b, 'STORE', Path(directory)), patch.object(b, 'uci', return_value=''):
            one = b.subscription_action('subscription_save', dict(url='https://example.org/one'))['id']
            two = b.subscription_action('subscription_save', dict(url='https://example.org/two', default='1', update_interval='60'))['id']
            result = b.subscription_action('subscriptions', {})
            self.assertEqual(result['default_id'], two)
            self.assertEqual([s['name'] for s in result['subscriptions']], ['example.org','example.org (2)'])
            self.assertEqual(result['subscriptions'][1]['update_interval'], 60)
            with self.assertRaises(ValueError):
                b.subscription_action('subscription_save', dict(id=two, name='Two', url='https://example.org/two', update_interval='1'))
            b.subscription_action('subscription_delete', dict(id=two))
            self.assertEqual(b.subscription_action('subscriptions', {})['default_id'], one)

    def test_scheduled_update_due_failure_and_disabled(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(b, 'STORE', Path(directory)), patch.object(b, 'RUN', Path(directory)), patch.object(b, 'settings', return_value={}), patch.object(b, 'uci', return_value=''):
            node = b.parse_vless(BASE)
            b.atomic(b.STORE / 'subscriptions.json', [dict(id='one', name='One', url='https://example.org', nodes=[node], updated_at=1, update_interval=60)])
            with patch.object(b.time, 'time', return_value=10000), patch.object(b, 'fetch_subscription', return_value=BASE + '\n' + BASE.replace('192.0.2.1','192.0.2.2')) as fetch:
                b.refresh_due()
                fetch.assert_called_once()
                b.refresh_due()
                fetch.assert_called_once()
            self.assertEqual(len(b.load_nodes()), 2)
            with patch.object(b.time, 'time', return_value=14000), patch.object(b, 'fetch_subscription', side_effect=ValueError('download failed')):
                b.refresh_due()
            self.assertEqual(len(b.load_nodes()), 2)
            self.assertEqual(b.load_subscriptions()[0]['last_error'], 'download failed')
            sources = b.load_subscriptions(); sources[0]['update_interval'] = 0
            b.atomic(b.STORE / 'subscriptions.json', sources)
            with patch.object(b.time, 'time', return_value=50000), patch.object(b, 'fetch_subscription') as fetch:
                b.refresh_due(); fetch.assert_not_called()

    def test_schedule_install_preserves_other_cron_jobs(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(b, 'run'):
            path = Path(directory) / 'root'
            path.write_text('0 3 * * * /usr/bin/existing-job\n')
            b.install_schedule(path); b.install_schedule(path)
            self.assertIn('/usr/bin/existing-job', path.read_text())
            self.assertEqual(path.read_text().count('# luci-singbox-subscriptions'), 1)

    def test_named_subscriptions_migrate_and_refresh_independently(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            original = b.parse_vless(BASE + '#Original')
            b.atomic(folder / 'nodes.json', [original])
            def get(key, default=''):
                return {'singbox_gui.main.subscription':'https://example.org/private',
                        'singbox_gui.main.selected':original['id']}.get(key, default)
            with patch.object(b, 'STORE', folder), patch.object(b, 'uci', side_effect=get), patch.object(b, 'settings', return_value={}):
                self.assertEqual(b.load_nodes()[0]['id'], original['id'])
                self.assertEqual(b.load_subscriptions()[0]['name'], 'example.org')
                added = b.subscription_action('subscription_save', dict(id='', name='Second', url='https://second.example/sub'))['id']
                with patch.object(b, 'fetch_subscription', return_value=BASE.replace('192.0.2.1','192.0.2.2') + '#Second'):
                    b.subscription_action('subscription_refresh', dict(id=added))
                self.assertEqual(len(b.load_nodes()), 2)
                self.assertEqual(b.load_subscriptions()[0]['nodes'][0]['id'], original['id'])
                snapshot = (folder / 'subscriptions.json').read_bytes()
                with patch.object(b, 'fetch_subscription', side_effect=ValueError('network failed')):
                    with self.assertRaises(ValueError):
                        b.subscription_action('subscription_refresh', dict(id=added))
                self.assertEqual((folder / 'subscriptions.json').read_bytes(), snapshot)
                # The removed global selection no longer prevents deleting an unused source.
                b.subscription_action('subscription_delete', dict(id=added))
                self.assertEqual([n['id'] for n in b.load_nodes()], [original['id']])

    def test_duplicate_nodes_keep_both_subscription_memberships(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(b, 'STORE', Path(directory)):
            node = b.parse_vless(BASE)
            b.atomic(b.STORE / 'subscriptions.json', [dict(id=s, name=s, url='', nodes=[node]) for s in ('one','two')])
            nodes = b.load_nodes()
            self.assertEqual(len(nodes), 1)
            self.assertEqual(nodes[0]['subscription_ids'], ['one','two'])
            with patch.object(b, 'uci', return_value=node['id']):
                b.subscription_action('subscription_delete', dict(id='one'))
            self.assertEqual(b.load_nodes()[0]['subscription_ids'], ['two'])

    def test_subscription_import_replaces_only_target(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(b, 'STORE', Path(directory)):
            first, second = b.parse_vless(BASE), b.parse_vless(BASE.replace('192.0.2.1','192.0.2.2'))
            b.atomic(b.STORE / 'subscriptions.json', [dict(id='one', name='One', url='', nodes=[first]), dict(id='two', name='Two', url='', nodes=[second])])
            b.dispatch('import', dict(text=BASE.replace('192.0.2.1','192.0.2.3'), subscription_id='two'))
            sources = b.load_subscriptions()
            self.assertEqual(sources[0]['nodes'][0]['id'], first['id'])
            self.assertNotEqual(sources[1]['nodes'][0]['id'], second['id'])

    def test_restart_validates_before_restarting_without_changing_uci(self):
        with patch.object(b, 'settings', return_value={'enabled':'1'}), patch.object(b, 'generate') as generate, patch.object(b, 'run') as command:
            self.assertTrue(b.dispatch('restart', {})['ok'])
            generate.assert_called_once_with()
            command.assert_called_once_with('/etc/init.d/singbox-gui', 'restart')
        with patch.object(b, 'settings', return_value={'enabled':'0'}), patch.object(b, 'run') as command:
            with self.assertRaises(ValueError):
                b.dispatch('restart', {})
            command.assert_not_called()

    def test_logs_include_actual_service_tag_without_ansi_or_secrets(self):
        lines = ['daemon.err singbox-gui-core[123]: \x1b[36mINFO\x1b[0m ' + UUID,
                 'daemon.err sing-box[456]: error',
                 'daemon.info unrelated[789]: do not include']
        with patch.object(b, 'run', return_value='\n'.join(lines)):
            text = b.dispatch('logs', {})['text']
        self.assertIn('singbox-gui-core[123]: INFO [UUID]', text)
        self.assertIn('sing-box[456]: error', text)
        self.assertNotIn('unrelated', text)
        self.assertNotIn('\x1b', text)
        self.assertNotIn(UUID, text)

    def test_firewall_creation_can_be_enabled_or_skipped(self):
        def uci(key, default=''):
            return {'network.sbvpn':'interface','network.sbvpn.singbox_gui':'1','pbr.config':'pbr'}.get(key,default)
        def command(*args, **kwargs):
            return "firewall.lan.name='lan'" if args==('uci','-q','show','firewall') else ''
        for enabled in ('0','1'):
            with self.subTest(enabled=enabled),tempfile.TemporaryDirectory() as directory:
                with patch.object(b,'STORE',Path(directory)),patch.object(b,'uci',side_effect=uci),patch.object(b,'run',side_effect=command) as commands:
                    b.configure_network(dict(S,manage_firewall=enabled))
                mutations=[call.args for call in commands.call_args_list if len(call.args)>2 and call.args[0]=='uci' and call.args[1] in ('set','add_list') and 'firewall.singbox_gui' in call.args[2]]
                self.assertEqual(bool(mutations),enabled=='1')
                if enabled=='1':
                    self.assertTrue(any('firewall.singbox_gui.input=ACCEPT' in c for c in mutations))
                    self.assertTrue(any('firewall.singbox_gui.network=sbvpn' in c for c in mutations))

    def test_automatic_user_agent_tracks_current_core(self):
        with patch.object(b, 'core_version', return_value='1.14.9'):
            self.assertEqual(b.subscription_headers(dict(subscription_user_agent_mode='auto', subscription_user_agent='old'))['User-Agent'], 'sing-box/1.14.9')
        self.assertEqual(b.subscription_headers(dict(subscription_user_agent_mode='custom', subscription_user_agent='Custom/2'))['User-Agent'], 'Custom/2')
    def test_manual_config_keeps_managed_tun_and_pbr(self):
        cfg = b.config(S, b.parse_vless(BASE))
        b.validate_manual(cfg, S)
        for key, value in [('auto_route', True), ('auto_redirect', True), ('interface_name', 'other0')]:
            invalid = copy.deepcopy(cfg); invalid['inbounds'][0][key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                b.validate_manual(invalid, S)

    def test_manual_config_survives_generation(self):
        cfg = b.config(S, b.parse_vless(BASE)); cfg['log']['level'] = 'warn'
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            (folder / 'manual.json').write_text(json.dumps(cfg))
            with patch.object(b, 'STORE', folder), patch.object(b, 'RUN', folder), patch.object(b, 'settings', return_value=dict(S, manual_enabled='1')):
                b.generate()
            self.assertEqual(json.loads((folder / 'config.json').read_text()), cfg)

    def test_manual_apply_failure_restores_saved_config(self):
        cfg = b.config(S, b.parse_vless(BASE))
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory); old = b'{"previous":true}'
            (folder / 'manual.json').write_bytes(old)
            with patch.object(b, 'STORE', folder), patch.object(b, 'RUN', folder), patch.object(b, 'settings', return_value=dict(S, manual_enabled='0', enabled='1')), patch.object(b, 'run', return_value=''), patch.object(b, 'apply', side_effect=ValueError('test failure')):
                with self.assertRaises(ValueError):
                    b.config_editor('config_save', json.dumps(cfg))
            self.assertEqual((folder / 'manual.json').read_bytes(), old)

    def test_probe_options_presets_and_custom_url(self):
        for preset, url in b.PROBE_URLS.items():
            self.assertEqual(b.probe_options(dict(probe_method='url_test', probe_url_preset=preset))[1], url)
        self.assertEqual(b.probe_options(dict(probe_method='url_test', probe_url_preset='custom', probe_custom_url='https://example.com/check'))[1], 'https://example.com/check')
        for url in ('file:///etc/passwd', 'https://user:password@example.com', 'https://example.com/\r\n'):
            with self.subTest(url=url), self.assertRaises(ValueError):
                b.probe_options(dict(probe_method='url_test', probe_url_preset='custom', probe_custom_url=url))

    def test_icmp_timeout_does_not_skip_tcp_and_uses_node_port(self):
        fake = MagicMock()
        fake.__enter__.return_value = fake
        def connect(target):
            if target[1] == 443:
                raise ConnectionRefusedError()
        fake.connect.side_effect = connect
        with patch.object(b, 'probe_icmp', return_value=None), patch.object(b.socket, 'socket', return_value=fake):
            measured = b.probe_server(('192.0.2.1', 8443))
        self.assertEqual(measured['icmp_error'], 'no_reply')
        self.assertNotIn('tcp443_ms', measured)
        self.assertIsNotNone(measured['tcp_ms'])
        self.assertEqual(measured['tcp_port'], 8443)

    def test_dns_failure_is_not_reported_as_server_timeout(self):
        with patch.object(b, 'probe_resolve', return_value=[]), patch.object(b.socket, 'socket') as sock:
            measured = b.probe_server(('unresolved.example', 443))
        self.assertEqual(measured['icmp_error'], 'dns')
        self.assertEqual(measured['tcp_error'], 'dns')
        sock.assert_not_called()

    def test_base64_and_dedup(self):
        text = BASE + '#one\n' + BASE + '#two'
        for encoded in (text, base64.b64encode(text.encode()).decode().rstrip('=')):
            nodes, warnings = b.parse_subscription(encoded)
            self.assertEqual(len(nodes), 1)
            self.assertEqual(warnings, [])

    def test_hwid_headers_and_injection(self):
        s = dict(hwid_enabled='1', hwid='router-123', subscription_user_agent='TestClient/1.0',
                 device_os='OpenWrt', device_os_version='25.12.6', device_model='N6005')
        headers = b.subscription_headers(s)
        self.assertEqual(headers['x-hwid'], 'router-123')
        self.assertEqual(headers['x-ver-os'], '25.12.6')
        self.assertNotIn('x-hwid', b.subscription_headers(dict(s, hwid_enabled='0')))
        for key in ('hwid', 'subscription_user_agent', 'device_model'):
            with self.subTest(key=key), self.assertRaises(ValueError):
                b.subscription_headers(dict(s, **{key: 'abc\r\nx-evil: yes'}))

    def test_ipv6_and_ws(self):
        node = b.parse_vless('vless://' + UUID + '@[2001:db8::1]:443?type=ws&security=tls&sni=example.com&path=%2Fws&host=example.com#hello%20world')
        self.assertEqual(node['name'], 'hello world')
        self.assertEqual(node['outbound']['transport']['path'], '/ws')
        self.assertEqual(node['outbound']['server'], '2001:db8::1')

    def test_reject_unsupported_insecure_and_malformed(self):
        for uri in (BASE + '?type=xhttp', BASE + '?encryption=mlkem768x25519plus',
                    BASE + '?security=tls&allowInsecure=1', BASE + '?unknown=1',
                    BASE + '?headerType=http', 'vless://bad@host:443', BASE + '?security=reality'):
            with self.subTest(uri=uri), self.assertRaises(ValueError):
                b.parse_vless(uri)

    def test_preserve_nodes_on_failed_parse(self):
        with self.assertRaises(ValueError):
            b.parse_subscription('broken subscription')

    def test_https_dns_proxy_is_primary(self):
        cfg = b.config(dict(S, dns_mode='https_dns_proxy'), b.parse_vless(BASE))
        self.assertEqual(len(cfg['dns']['servers']), 1)
        self.assertEqual(cfg['dns']['servers'][0]['server'], '127.0.0.1')
        self.assertEqual(cfg['dns']['servers'][0]['server_port'], 53)
        self.assertEqual(cfg['dns']['servers'][0]['detour'], 'dns-local')
        self.assertEqual(cfg['outbounds'][0]['domain_resolver'], 'router-dns')
        self.assertNotIn('remote', json.dumps(cfg))
        with tempfile.NamedTemporaryFile(mode='w') as f:
            json.dump(cfg, f); f.flush()
            r = subprocess.run([os.environ.get('SINGBOX_TEST_BINARY', '/usr/bin/sing-box'), 'check', '-c', f.name], capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, r.stderr)

    def test_unsafe_interface_and_dns(self):
        node = b.parse_vless(BASE)
        for key, value in [('interface', 'wan;reboot'), ('uplink', '../etc'),
                           ('dns', 'file:///etc/passwd'), ('mtu', '100'), ('address', '8.8.8.8/30')]:
            s = dict(S, **{key: value})
            with self.subTest(key=key), self.assertRaises(ValueError):
                b.config(s, node)

    def test_all_configurations_with_actual_sing_box(self):
        transports = ['', '?security=tls&type=ws&sni=example.com&host=example.com&path=%2Fws',
                      '?security=tls&type=grpc&sni=example.com&serviceName=test',
                      '?security=tls&type=h2&sni=example.com&host=example.com',
                      '?security=reality&flow=xtls-rprx-vision&sni=example.com&pbk=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&sid=1234&fp=chrome']
        for transport in transports:
            for dns in ('1.1.1.1', 'tcp://1.1.1.1', 'tls://one.one.one.one',
                        'https://1.1.1.1/dns-query', 'https://cloudflare-dns.com/dns-query'):
                with self.subTest(transport=transport, dns=dns):
                    cfg = b.config(dict(S, dns=dns), b.parse_vless(BASE + transport))
                    self.assertFalse(cfg['inbounds'][0]['auto_route'])
                    self.assertFalse(cfg['inbounds'][0]['auto_redirect'])
                    with tempfile.NamedTemporaryFile(mode='w', suffix='.json') as f:
                        json.dump(cfg, f); f.flush()
                        r = subprocess.run([os.environ.get('SINGBOX_TEST_BINARY', '/usr/bin/sing-box'), 'check', '-c', f.name], capture_output=True, text=True)
                        self.assertEqual(r.returncode, 0, r.stderr)


if __name__ == '__main__':
    unittest.main(verbosity=2)
