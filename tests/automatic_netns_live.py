"""Start automatic TUN routing inside a private network namespace; host routes are untouched."""
import ctypes,importlib.machinery,importlib.util,json,os,subprocess,sys,tempfile,time
from pathlib import Path
loader=importlib.machinery.SourceFileLoader('b',sys.argv[1]);spec=importlib.util.spec_from_loader(loader.name,loader);b=importlib.util.module_from_spec(spec);loader.exec_module(b)
before=subprocess.check_output(['ip','rule','show']);nft=subprocess.check_output(['nft','-s','list','ruleset'],stderr=subprocess.DEVNULL)
child=os.fork()
if child==0:
 try:
  libc=ctypes.CDLL(None,use_errno=True)
  if libc.unshare(0x40000000)!=0:raise OSError(ctypes.get_errno(),'unshare(CLONE_NEWNET)')
  subprocess.run(['ip','link','set','lo','up'],check=True)
  settings=dict(interface='sbtest',device='sb-auto-test',uplink='lo',source_zone='lan',address='172.30.250.1/30',mtu='1400',dns='1.1.1.1',bootstrap_dns='1.1.1.1',dns_mode='https_dns_proxy',dns_detour='direct')
  with tempfile.TemporaryDirectory(prefix='sb-auto-netns-') as directory:
   folder=Path(directory);profile=b.routing.defaults();profile['capture_mode']='automatic'
   cfg,_=b.routing.compile_profile(profile,b.config(settings,None,with_routing=False),[],settings,folder)
   b.atomic(folder/'config.json',cfg)
   with open(folder/'log','w') as log:
    process=subprocess.Popen([b.core_binary(),'run','-c',str(folder/'config.json')],stdout=log,stderr=log)
    try:
     time.sleep(2)
     if process.poll() is not None:raise AssertionError((folder/'log').read_text())
     rules=subprocess.check_output(['ip','rule','show'],text=True)
     assert '2022' in rules,rules
     subprocess.run(['ip','link','show','sb-auto-test'],stdout=subprocess.DEVNULL,check=True)
     assert b'sing-box' in subprocess.check_output(['nft','-s','list','ruleset'])
     print('PASS: automatic TUN, kernel policy routes and nftables started inside isolated network namespace',flush=True)
    finally:
     if process.poll() is None:process.terminate();process.wait(timeout=5)
  os._exit(0)
 except Exception as error:
  print('Automatic routing namespace test:',str(error),flush=True);os._exit(1)
_,status=os.waitpid(child,0)
assert subprocess.check_output(['ip','rule','show'])==before,'Host policy routes changed'
assert subprocess.check_output(['nft','-s','list','ruleset'],stderr=subprocess.DEVNULL)==nft,'Host nftables changed'
assert os.waitstatus_to_exitcode(status)==0,'Isolated automatic routing startup failed'
print('PASS: host network routes and nftables unchanged')
