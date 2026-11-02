import ctypes,os,subprocess,json,tempfile,time,sys
from pathlib import Path
CORE=os.environ.get('SINGBOX_TEST_BINARY','/usr/bin/sing-box')
def cmd(*args):return subprocess.run(args,check=True,capture_output=True,text=True).stdout
def unshare():
 if ctypes.CDLL(None,use_errno=True).unshare(0x40000000):raise OSError(ctypes.get_errno(),'unshare')
def lab(mode):
 unshare();cmd('ip','link','set','lo','up')
 cmd('ip','link','add','lanlab','type','veth','peer','name','clientlab')
 cmd('ip','addr','add','192.168.77.1/24','dev','lanlab');cmd('ip','link','set','lanlab','up')
 cmd('ip','link','add','wanlab','type','veth','peer','name','wanpeer');cmd('ip','addr','add','198.18.0.1/24','dev','wanlab');cmd('ip','link','set','wanlab','up');cmd('ip','link','set','wanpeer','up');cmd('ip','route','add','default','via','198.18.0.2')
 ready_r,ready_w=os.pipe();go_r,go_w=os.pipe();pid=os.fork()
 if pid==0:
  try:
   unshare();os.write(ready_w,b'1');os.read(go_r,1);cmd('ip','link','set','lo','up');cmd('ip','link','set','clientlab','up')
   r=subprocess.run(['udhcpc','-f','-n','-q','-t','3','-T','2','-i','clientlab','-s','/bin/true'],capture_output=True,text=True,timeout=12)
   print(mode,'DHCP CLIENT',r.returncode,(r.stdout+r.stderr).strip(),flush=True);os._exit(r.returncode)
  except Exception as e:print('CLIENT ERROR',e,flush=True);os._exit(2)
 os.read(ready_r,1);cmd('ip','link','set','clientlab','netns',str(pid))
 with tempfile.TemporaryDirectory() as d:
  p=Path(d);procs=[]
  try:
   log=(p/'dns.log').open('w');procs.append(subprocess.Popen(['dnsmasq','--no-daemon','--conf-file=/dev/null','--port=0','--interface=lanlab','--bind-interfaces','--dhcp-range=192.168.77.100,192.168.77.150,255.255.255.0,1h','--dhcp-leasefile='+str(p/'leases'),'--pid-file='+str(p/'pid'),'--log-dhcp','--user=root'],stdout=log,stderr=log))
   if mode!='baseline':
    excludes=['127.0.0.0/8','10.0.0.0/8','172.16.0.0/12','192.168.0.0/16','169.254.0.0/16','224.0.0.0/4']
    if mode=='fixed':excludes+=['0.0.0.0/8','240.0.0.0/4']
    cfg={'log':{'level':'debug'},'inbounds':[{'type':'tun','tag':'tun-in','interface_name':'tunlab','address':['172.30.250.1/30'],'auto_route':True,'auto_redirect':True,'strict_route':False,'dns_mode':'disabled','stack':'gvisor' if mode=='fixed' else 'system','route_exclude_address':excludes}],'outbounds':[{'type':'direct','tag':'direct','bind_interface':'wanlab'}],'route':{'final':'direct'}}
    (p/'config.json').write_text(json.dumps(cfg));slog=(p/'core.log').open('w');procs.append(subprocess.Popen([CORE,'run','-c',str(p/'config.json')],stdout=slog,stderr=slog))
   time.sleep(1);os.write(go_w,b'1');_,status=os.waitpid(pid,0)
   assert 'DHCPACK' in (p/'dns.log').read_text(), 'No DHCP ACK'
   if mode!='baseline':assert procs[-1].poll() is None,(p/'core.log').read_text()
   return os.waitstatus_to_exitcode(status)
  finally:
   for proc in procs:proc.terminate();proc.wait(timeout=5)
for mode in ['baseline','old','fixed']:
 child=os.fork()
 if child==0:
  try:os._exit(lab(mode))
  except Exception as e:print('LAB ERROR',e,flush=True);os._exit(3)
 _,status=os.waitpid(child,0);assert os.waitstatus_to_exitcode(status)==0,mode;print('PASS DHCP',mode,flush=True)
