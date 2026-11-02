"""Check bounded parallelism, per-node measurements, DNS reuse, progress and raw ICMP."""
import importlib.machinery,importlib.util,tempfile,time,threading,sys
from pathlib import Path
from unittest.mock import patch
loader=importlib.machinery.SourceFileLoader('b',sys.argv[1] if len(sys.argv)>1 else '/usr/libexec/singbox-gui');spec=importlib.util.spec_from_loader(loader.name,loader);b=importlib.util.module_from_spec(spec);loader.exec_module(b)
base='vless://12345678-1234-5678-9234-567812345678@192.0.2.1:443'
first=b.parse_vless(base);second=b.parse_vless(base.replace('12345678','22345678'));third=b.parse_vless(base.replace('192.0.2.1','192.0.2.2'))
calls=[];active=[0];peak=[0];lock=threading.Lock();progress=[];dns=[]
def measure(target,**kwargs):
 with lock:active[0]+=1;peak[0]=max(peak[0],active[0]);calls.append(target)
 try:
  assert kwargs['timeout']==3;time.sleep(.08)
  return dict(tcp_ms=1.0,tcp_error=None)
 finally:
  with lock:active[0]-=1
def resolve(server,*args):dns.append(server);time.sleep(.02);return [server]
with tempfile.TemporaryDirectory() as directory,patch.object(b,'RUN',Path(directory)),patch.object(b,'load_nodes',return_value=[first,second,third]),patch.object(b,'settings',return_value=dict(uplink='eth0')),patch.object(b,'probe_server',side_effect=measure),patch.object(b,'probe_resolve',side_effect=resolve):
 result=b.latency(dict(ids=[third['id'],second['id'],first['id']],options=dict(probe_method='tcp_connect',probe_timeout='3')),progress=progress.append)
 assert len(calls)==3 and calls.count(('192.0.2.1',443))==2,calls
 assert 2<=peak[0]<=6,peak
 assert sorted(dns)==['192.0.2.1','192.0.2.2'],dns
 assert [r['completed'] for r in progress]==[1,2,3]
 assert all(len(r['latency'])==r['completed'] for r in progress)
 assert len(result['latency'])==3
for address in ('127.0.0.1','::1'):
 start=time.monotonic();ms=b.probe_icmp(address,'lo',1)
 assert ms is not None and ms<100,(address,ms)
 assert time.monotonic()-start<.6,'ICMP unnecessarily waits for a full second'
print('PASS: bounded parallel measurements, separate shared-endpoint probes, DNS reuse, per-node progress, IPv4/IPv6 raw ICMP')
