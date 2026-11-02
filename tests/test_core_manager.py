import hashlib,importlib.machinery,importlib.util,json,tempfile,unittest
from pathlib import Path
from unittest.mock import patch

source=Path(__file__).resolve().parents[1]/'root/usr/libexec/singbox-core-manager'
loader=importlib.machinery.SourceFileLoader('manager',str(source));spec=importlib.util.spec_from_loader('manager',loader)
m=importlib.util.module_from_spec(spec);loader.exec_module(m)

class CoreTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();root=Path(self.temp.name)
        self.core=root/'core';self.core.mkdir();self.run=root/'run';self.run.mkdir();self.meta=root/'updates.json'
        self.patches=[patch.object(m,'CORE',self.core),patch.object(m,'RUN',self.run),patch.object(m,'META',self.meta)]
        for p in self.patches:p.start()
    def tearDown(self):
        for p in reversed(self.patches):p.stop()
        self.temp.cleanup()
    def test_switch_preserves_validated_runtime_during_restart(self):
        candidate=Path(self.temp.name)/'candidate';candidate.write_bytes(b'new')
        config={'inbounds':[{'type':'tun','interface_name':'test0'}]}
        (self.run/'config.json').write_text(json.dumps(config))
        state=json.dumps({'singbox-gui':{'instances':{'main':{'running':True}}}})
        def restart(running):
            self.assertTrue(running)
            self.assertEqual(m.read(self.run/'recovery.json'),config)
        with patch.object(m,'command',return_value=state),patch.object(m,'restart_if_running',side_effect=restart):
            m.switch(candidate,'1.14.5')
        self.assertFalse((self.run/'recovery.json').exists())
        self.assertTrue((self.run/'lock').exists())

    def test_switch_does_not_touch_system_binary_and_rolls_back_on_failure(self):
        current=self.core/'sing-box';current.write_bytes(b'previous-core')
        candidate=Path(self.temp.name)/'candidate';candidate.write_bytes(b'new-core')
        state=json.dumps({'singbox-gui':{'instances':{'main':{'running':True}}}})
        with patch.object(m,'command',return_value=state),patch.object(m,'restart_if_running',side_effect=[ValueError('startup failed'),None]):
            with self.assertRaises(ValueError):m.switch(candidate,'1.14.5')
        self.assertEqual(current.read_bytes(),b'previous-core')
        self.assertEqual(candidate.read_bytes(),b'new-core')
    def test_switch_checks_config_before_replacing_existing_core(self):
        current=self.core/'sing-box';current.write_bytes(b'old')
        candidate=Path(self.temp.name)/'candidate';candidate.write_bytes(b'new')
        (self.run/'config.json').write_text('{}')
        with patch.object(m,'command',side_effect=ValueError('unsupported config')):
            with self.assertRaises(ValueError):m.switch(candidate,'1.14.5')
        self.assertEqual(current.read_bytes(),b'old')
    def test_digest_mismatch_does_not_switch_core(self):
        release={'tag_name':'v1.14.5','assets':[{'name':'sing-box-1.14.5-linux-amd64-musl.tar.gz',
            'digest':'sha256:'+'0'*64,'browser_download_url':'https://github.com/SagerNet/sing-box/releases/download/v1.14.5/test'}]}
        def download(url,path,limit):path.write_bytes(b'corrupt archive')
        with patch.object(m.platform,'machine',return_value='x86_64'),patch.object(m,'get_json',return_value=release),patch.object(m,'download',side_effect=download),patch.object(m,'switch') as switch:
            with self.assertRaisesRegex(ValueError,'SHA-256 mismatch'):m.install('1.14.5',Path(self.temp.name))
        switch.assert_not_called()
    def test_download_rejects_non_official_urls(self):
        with self.assertRaises(ValueError):m.download('https://example.com/sing-box',self.run/'binary',1000)
    def test_release_cache_excludes_prereleases_and_incompatible_archives(self):
        releases=[{'tag_name':'v1.15.0-alpha.1','prerelease':True},
            {'tag_name':'v1.14.5','assets':[]},
            {'tag_name':'v1.14.4','assets':[{'name':'sing-box-1.14.4-linux-amd64-musl.tar.gz'}]}]
        with patch.object(m,'get_json',return_value=releases):metadata=m.releases(self.run)
        self.assertEqual(metadata['latest'],'1.14.4')
        self.assertEqual(len(metadata['versions']),1)
        self.assertGreater(metadata['last_checked'],0)
    def test_failed_job_is_terminal_and_retains_error_date(self):
        with patch.object(m,'releases',side_effect=ValueError('DNS unavailable')):
            m.worker('check','','job')
        self.assertEqual(m.read(self.run/'core-job.json')['state'],'done')
        self.assertFalse(m.read(self.run/'core-job.json')['ok'])
        self.assertEqual(m.read(self.meta)['last_error'],'DNS unavailable')
        self.assertGreater(m.read(self.meta)['last_attempt'],0)

if __name__=='__main__':unittest.main(verbosity=2)
