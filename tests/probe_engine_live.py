"""Real loopback VLESS forwarding: valid UUID succeeds, invalid UUID must fail."""
import importlib.machinery,importlib.util,json,sys,socket,subprocess,tempfile,time,threading
from pathlib import Path
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from unittest.mock import patch
loader=importlib.machinery.SourceFileLoader('probe_backend',sys.argv[1]);spec=importlib.util.spec_from_loader(loader.name,loader);b=importlib.util.module_from_spec(spec);loader.exec_module(b)
hits=[]
class Handler(BaseHTTPRequestHandler):
 def do_GET(self):
  hits.append(self.path);self.send_response(204);self.end_headers()
 def log_message(self,*a):pass
http=ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=http.serve_forever,daemon=True).start()
with tempfile.TemporaryDirectory() as directory:
 directory=Path(directory)
 with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
 uuid='12345678-1234-5678-9234-567812345678'
 server=dict(log=dict(level='error'),inbounds=[dict(type='vless',tag='vless-test',listen='127.0.0.1',listen_port=port,users=[dict(uuid=uuid)])],outbounds=[dict(type='direct',tag='direct')],route=dict(final='direct'))
 b.atomic(directory/'server.json',server)
 process=subprocess.Popen([b.core_binary(),'run','-c',str(directory/'server.json')],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 try:
  for _ in range(40):
   try:
    with socket.create_connection(('127.0.0.1',port),.1):break
   except OSError:time.sleep(.05)
  settings=dict(interface='sbvpn',device='sb-tun0',uplink='lo',source_zone='lan',address='172.30.255.1/30',mtu='1400',dns='https://1.1.1.1/dns-query',bootstrap_dns='1.1.1.1',dns_detour='proxy',dns_mode='https_dns_proxy',probe_dns='default')
  good=b.parse_vless('vless://'+uuid+'@127.0.0.1:'+str(port))
  bad=b.parse_vless('vless://22345678-1234-5678-9234-567812345678@127.0.0.1:'+str(port))
  # A direct fallback would incorrectly make the invalid UUID look successful.
  profile=b.routing.defaults();profile['final']='direct'
  with patch.object(b,'RUN',directory),patch.object(b,'routing_load',return_value=profile):
   success=b.probe_url(good,settings,'http://127.0.0.1:'+str(http.server_port)+'/valid',4)
   failure=b.probe_url(bad,settings,'http://127.0.0.1:'+str(http.server_port)+'/invalid',4)
  assert success['http_code']==204 and success['test_ms'] is not None,success
  assert failure['test_ms'] is None and failure['test_error'],failure
  assert hits==['/valid'],hits
  tcp=b.probe_server(('127.0.0.1',port),tcp_only=True,uplink='lo',timeout=2)
  assert tcp['tcp_ms'] is not None and tcp['connected_address']=='127.0.0.1',tcp
  print('PASS: actual VLESS forwarding succeeds with valid UUID; invalid UUID fails without direct fallback; TCP Connect binds uplink')
 finally:
  process.terminate();process.wait(timeout=3)
http.shutdown();http.server_close()
