"""Real 1.14.4 rule semantics: generated JSON vs Throne-style native rules.
Only temporary loopback listeners; no UCI, TUN, firewall or external traffic.
"""
import copy,importlib.util,json,os,socket,subprocess,tempfile,threading,time
from pathlib import Path
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
module=Path(__file__).resolve().parents[1]/'root/usr/libexec/singbox_routing.py'
spec=importlib.util.spec_from_file_location('routing',module);r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)
core=os.environ.get('SINGBOX_TEST_BINARY','/usr/bin/sing-box')
version=subprocess.check_output([core,'version'],text=True).splitlines()[0]
assert '1.14.4' in version,version
class Handler(BaseHTTPRequestHandler):
 def do_GET(self):
  self.send_response(200);self.send_header('Content-Length','2');self.end_headers();self.wfile.write(b'OK')
 def log_message(self,*args):pass
http=ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=http.serve_forever,daemon=True).start();port=http.server_port
# Fields for the independent native reference are explicit, not compiled from the UI model.
cases=[
 ('domain alternatives',{'domain':['a.test'],'domain_suffix':['b.test']},{'domain':['a.test'],'domain_suffix':['b.test']},[('a.test',1),('sub.b.test',1),('other.test',0)]),
 ('regex alternative',{'domain':['a.test'],'domain_regex':[r'^x[0-9]+\.test$']},{'domain':['a.test'],'domain_regex':[r'^x[0-9]+\.test$']},[('a.test',1),('x12.test',1),('evilx12.test',0)]),
 ('address alternatives',{'domain':['never.test'],'ip_cidr':['127.0.0.1/32']},{'domain':['never.test'],'ip_cidr':['127.0.0.1/32']},[('other.test',1)]),
 ('private destination alternative',{'domain':['never.test'],'ip_is_private':True},{'domain':['never.test'],'ip_is_private':True},[('other.test',1)]),
 ('source alternatives',{'source_ip_cidr':['192.0.2.0/24'],'source_ip_is_private':True},{'source_ip_cidr':['192.0.2.0/24'],'source_ip_is_private':True},[('other.test',1)]),
 ('domain AND port',{'domain':['a.test'],'port':[str(port)]},{'domain':['a.test'],'port':[port]},[('a.test',1),('other.test',0)]),
 ('wrong port',{'domain':['a.test'],'port':['1']},{'domain':['a.test'],'port':[1]},[('a.test',0)]),
 ('port or range',{'port':['1',f'{port}:{port}']},{'port':[1],'port_range':[f'{port}:{port}']},[('other.test',1)]),
 ('source port or range',{'source_port':['1','1024:65535']},{'source_port':[1],'source_port_range':['1024:65535']},[('other.test',1)]),
 ('network protocol',{'domain':['a.test'],'network':['tcp'],'protocol':['http']},{'domain':['a.test'],'network':['tcp'],'protocol':['http']},[('a.test',1),('other.test',0)]),
 ('network mismatch',{'domain':['a.test'],'network':['udp']},{'domain':['a.test'],'network':['udp']},[('a.test',0)]),
 ('IPv6 mismatch',{'ip_version':6},{'ip_version':6},[('other.test',0)]),
 ('IPv4 match',{'ip_version':4},{'ip_version':4},[('other.test',1)]),
 ('geosite plus domain',{'geosite':['fixture'],'domain':['a.test']},{'rule_set':['geosite-fixture'],'domain':['a.test']},[('a.test',1),('sub.set.test',1),('other.test',0)]),
 ('geosite plus custom set',{'geosite':['fixture'],'rule_set':['custom']},{'rule_set':['geosite-fixture','custom']},[('sub.set.test',1),('custom.test',1),('other.test',0)]),
]
base={'log':{'level':'error'},'inbounds':[],'outbounds':[{'type':'direct','tag':'direct','domain_resolver':'unused'}],'route':{'rules':[],'final':'direct'},'dns':{'servers':[{'type':'hosts','tag':'unused','predefined':{}}]}}
settings={'uplink':'lo','dns_mode':'https_dns_proxy'}
count=0
try:
 with tempfile.TemporaryDirectory(prefix='sb-rule-semantics-') as directory:
  root=Path(directory)
  (root/'set.json').write_text(json.dumps({'version':3,'rules':[{'domain_suffix':['set.test']}]}))
  (root/'custom.json').write_text(json.dumps({'version':3,'rules':[{'domain':['custom.test']}]}))
  for title,conditions,native,queries in cases:
   for invert in [False,True]:
    profile=r.defaults();profile.update(final='block',rules=[{'name':title,'conditions':conditions,'outbound':'direct','invert':invert}])
    profile['rule_sets']=[{'tag':'custom','url':'https://example.invalid/custom.json','format':'source'}]
    generated,required=r.compile_profile(profile,base,[],settings,root)
    if required:
     generated['route']['rule_set']=[{'type':'local','tag':x['tag'],'format':'source','path':str(root/('custom.json' if x['tag']=='custom' else 'set.json'))} for x in required]
    reference=copy.deepcopy(generated)
    reference['route']['rules'][1]={'type':'logical','mode':'and','rules':[{'inbound':['tun-in']},dict(native,invert=invert)],'action':'route','outbound':'direct'}
    for label,cfg in [('compiled',generated),('native',reference)]:
     with socket.socket() as sock:sock.bind(('127.0.0.1',0));listen=sock.getsockname()[1]
     cfg['inbounds']=[{'type':'socks','tag':'tun-in','listen':'127.0.0.1','listen_port':listen}]
     path=root/'config.json';path.write_text(json.dumps(cfg))
     checked=subprocess.run([core,'check','-c',str(path)],capture_output=True,text=True);assert checked.returncode==0,(title,checked.stderr)
     with (root/'log').open('w') as log:
      proc=subprocess.Popen([core,'run','-c',str(path)],stdout=log,stderr=log)
      try:
       for _ in range(60):
        assert proc.poll() is None,(root/'log').read_text()
        try:
         with socket.create_connection(('127.0.0.1',listen),timeout=.05):break
        except OSError:time.sleep(.02)
       for host,expected in queries:
        res=subprocess.run(['curl','-sS','--max-time','2','--noproxy','','--proxy',f'socks5://127.0.0.1:{listen}','-H','Host: '+host,f'http://127.0.0.1:{port}/'],capture_output=True,text=True)
        actual=res.returncode==0 and res.stdout=='OK';assert actual==bool(expected)^invert,(title,label,host,invert,actual,res.stderr)
        count+=1
      finally:proc.terminate();proc.wait(timeout=5)
 print('PASS:',count,'real requests; native Throne-style and generated rules agree, including inversion and rule-sets')
finally:http.shutdown();http.server_close()
