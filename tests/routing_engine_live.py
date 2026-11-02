"""Test compiled domain regex and geosite rules in an isolated loopback SOCKS instance."""
import importlib.machinery
import importlib.util
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import time

loader=importlib.machinery.SourceFileLoader('routing_backend',sys.argv[1])
spec=importlib.util.spec_from_loader(loader.name,loader)
b=importlib.util.module_from_spec(spec);loader.exec_module(b)
fixture=Path(sys.argv[2]);assert fixture.is_file()
hits=[]
class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        hits.append(self.headers.get('Host'))
        body=b'routing-test-ok'
        self.send_response(200);self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
    def log_message(self,*args):pass

http=ThreadingHTTPServer(('127.0.0.1',0),Handler)
threading.Thread(target=http.serve_forever,daemon=True).start()
with socket.socket() as sock:
    sock.bind(('127.0.0.1',0));socks_port=sock.getsockname()[1]
process=None
try:
    with tempfile.TemporaryDirectory(prefix='routing-engine-test-') as directory:
        root=Path(directory)
        settings=dict(interface='sb0',device='sb-test0',uplink='lo',source_zone='lan',address='172.30.255.1/30',mtu='1400',dns='1.1.1.1',bootstrap_dns='1.1.1.1',dns_mode='https_dns_proxy',dns_detour='direct')
        node=b.parse_vless('vless://12345678-1234-5678-9234-567812345678@127.0.0.1:9#Test')
        profile=b.routing.defaults();profile.update(enabled=True,final='block')
        profile['rules']=[dict(name='Regex direct',conditions=dict(domain_regex=[r'^regex\.example\.test$']),outbound='direct'),
                          dict(name='Geosite direct',conditions=dict(geosite=['google']),outbound='direct')]
        base=b.config(settings,node,with_routing=False)
        cfg,required=b.routing.compile_profile(profile,base,[node],settings,root,paths={'geosite-google':str(fixture)})
        cfg['inbounds']=[dict(type='socks',tag='tun-in',listen='127.0.0.1',listen_port=socks_port)]
        cfg['log']=dict(level='error',timestamp=False)
        # Prove initial_path works with no network source: the real SRS fixture
        # bootstraps a native remote set while its test URL is unreachable locally.
        cfg['route']['rule_set'][0]['url']='https://127.0.0.1:9/unavailable.srs'
        config=root/'config.json';config.write_text(json.dumps(cfg))
        check=subprocess.run(['/usr/bin/sing-box','check','-c',str(config)],capture_output=True,text=True)
        assert check.returncode==0,check.stderr
        with open(root/'engine.log','w') as log:
            process=subprocess.Popen(['/usr/bin/sing-box','run','-c',str(config)],stdout=log,stderr=log)
            for _ in range(50):
                if process.poll() is not None:raise AssertionError((root/'engine.log').read_text())
                try:
                    with socket.create_connection(('127.0.0.1',socks_port),timeout=.1):break
                except OSError:time.sleep(.1)
            def fetch(host):
                return subprocess.run(['curl','--silent','--show-error','--max-time','5','--noproxy','','--proxy','socks5://127.0.0.1:'+str(socks_port),'-H','Host: '+host,'http://127.0.0.1:'+str(http.server_port)+'/'],capture_output=True,text=True)
            one=fetch('regex.example.test');assert one.returncode==0 and one.stdout=='routing-test-ok',(one.returncode,one.stderr)
            two=fetch('www.google.com');assert two.returncode==0 and two.stdout=='routing-test-ok',(two.returncode,two.stderr)
            blocked=fetch('not-allowed.example.test');assert blocked.returncode!=0,'unmatched traffic must be rejected'
            assert hits==['regex.example.test','www.google.com'],hits
            print('PASS: real engine routes RE2 and official geosite-google through native initial_path; unmatched traffic rejected; no external network or TUN used')
            process.terminate();process.wait(timeout=5);process=None
finally:
    if process:
        process.terminate()
        try:process.wait(timeout=5)
        except subprocess.TimeoutExpired:process.kill();process.wait()
    http.shutdown();http.server_close()
