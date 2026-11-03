import importlib.machinery,importlib.util,json,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
source=Path(__file__).resolve().parents[1]/'root/usr/libexec/singbox-gui'
loader=importlib.machinery.SourceFileLoader('recovery_backend',str(source));spec=importlib.util.spec_from_loader(loader.name,loader);b=importlib.util.module_from_spec(spec);loader.exec_module(b)
class RecoveryTests(unittest.TestCase):
 def test_apply_finishes_netifd_before_starting_core(self):
  with tempfile.TemporaryDirectory() as directory,patch.object(b,'STORE',Path(directory)),patch.object(b,'RUN',Path(directory)):
   settings={'enabled':'1','device':'sb-tun0','interface':'sb0'}
   with patch.object(b,'settings',return_value=settings),patch.object(b,'managed_configs',return_value=()),patch.object(b,'generate',return_value=settings),patch.object(b,'configure_network'),patch.object(b,'run',return_value='{}') as calls,patch.object(b,'wait_service'),patch.object(b,'reload_pbr'),patch.object(b,'routing_load',return_value={'capture_mode':'automatic'}):
    b.apply()
   commands=[c.args for c in calls.call_args_list]
   start=commands.index(('/etc/init.d/singbox-gui','restart'))
   for command in [('ubus','call','network','reload','{}'),('/sbin/ifup','sb0'),('/etc/init.d/firewall','reload')]:
    self.assertLess(commands.index(command),start)
    self.assertNotIn(command,commands[start+1:])
 def test_generate_consumes_verified_runtime_without_regenerating_pending_gui(self):
  with tempfile.TemporaryDirectory() as directory,patch.object(b,'RUN',Path(directory)),patch.object(b,'settings',return_value={'manual_enabled':'0'}),patch.object(b,'run',return_value=''),patch.object(b,'uci',return_value='0'),patch.object(b,'config') as generate:
   old={'inbounds':[{'type':'tun','interface_name':'saved0'}],'route':{'final':'direct'}}
   b.atomic(b.RUN/'recovery.json',old);b.generate()
   self.assertEqual(json.loads((b.RUN/'config.json').read_text()),old)
   self.assertFalse((b.RUN/'recovery.json').exists());generate.assert_not_called()
 def test_manual_automatic_routes_reject_enabled_pbr(self):
  with tempfile.TemporaryDirectory() as directory,patch.object(b,'STORE',Path(directory)),patch.object(b,'RUN',Path(directory)),patch.object(b,'settings',return_value={'manual_enabled':'1','device':'test0'}),patch.object(b,'routing_load',return_value={'capture_mode':'automatic'}),patch.object(b,'uci',return_value='1'),patch.object(b,'run') as run:
   b.atomic(b.STORE/'manual.json',{'inbounds':[{'type':'tun','interface_name':'test0','auto_route':True}]})
   with self.assertRaisesRegex(ValueError,'Disable PBR'):b.generate()
   run.assert_not_called()
 def test_apply_failure_restarts_previous_runtime_and_restored_interface(self):
  with tempfile.TemporaryDirectory() as directory,patch.object(b,'STORE',Path(directory)),patch.object(b,'RUN',Path(directory)):
   settings={'enabled':'1','device':'new-tun','interface':'new0'}
   previous={'inbounds':[{'type':'tun','interface_name':'old-tun'}]}
   b.atomic(b.RUN/'config.json',previous);b.atomic(b.STORE/'interface.json',{'interface':'old0'})
   attempts=[]
   def run(*args,**kwargs):
    if args[:3]==('ubus','call','service'):return json.dumps({'singbox-gui':{'instances':{'main':{'running':True}}}})
    if args==('/etc/init.d/singbox-gui','restart'):
     attempts.append(args)
     if len(attempts)==1:raise ValueError('restart failed')
     self.assertEqual(json.loads((b.RUN/'recovery.json').read_text()),previous)
    return ''
   def generate():b.atomic(b.RUN/'config.json',{'new':True});return settings
   with patch.object(b,'settings',return_value=settings),patch.object(b,'managed_configs',return_value=()),patch.object(b,'generate',side_effect=generate),patch.object(b,'configure_network'),patch.object(b,'run',side_effect=run) as calls,patch.object(b,'wait_service'),patch.object(b,'reload_pbr'):
    with self.assertRaisesRegex(ValueError,'restart failed'):b.apply()
   self.assertEqual(len(attempts),2)
   self.assertEqual(json.loads((b.RUN/'config.json').read_text()),previous)
   self.assertFalse((b.RUN/'recovery.json').exists())
   self.assertTrue(any(c.args==('/sbin/ifup','old0') for c in calls.call_args_list))
if __name__=='__main__':unittest.main(verbosity=2)
