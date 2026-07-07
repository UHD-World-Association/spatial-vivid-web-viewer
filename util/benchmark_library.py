#!/usr/bin/env python3
"""Benchmark the unmodified Library demo via an existing ChromeDriver server.

Start the demo and ChromeDriver separately. Set UWA_CHROME_BINARY to the
Chrome executable, then: python util/benchmark_library.py LABEL 3
Optional UWA_WEBDRIVER_URL, UWA_BENCH_URL, UWA_BENCH_OUTPUT override defaults.
Each sample creates/deletes its own browser session. Warmup finishes before
clicking Library; the demo's decode-start/visible-frame timestamps are used
without alteration. Captures the existing Download timing JSON Blob.
Uses NVIDIA Vulkan in headless Chrome; verify printed renderer on other hosts.
"""
import json,urllib.request,urllib.error,time,pathlib,sys,base64,os
base=os.environ.get('UWA_WEBDRIVER_URL','http://127.0.0.1:4444')
out=pathlib.Path(os.environ.get('UWA_BENCH_OUTPUT','../timing_json/local_loop')); out.mkdir(parents=True,exist_ok=True)
def req(path,obj=None,method='POST'):
 r=urllib.request.Request(base+path,data=None if obj is None else json.dumps(obj).encode(),method=method,headers={'Content-Type':'application/json'})
 try:
  with urllib.request.urlopen(r,timeout=60) as x:return json.load(x)['value']
 except urllib.error.HTTPError as e: raise RuntimeError(e.read().decode())
label=sys.argv[1] if len(sys.argv)>1 else 'baseline'
for run in range(int(sys.argv[2]) if len(sys.argv)>2 else 1):
 if (out/f'{label}-{run+1}.json').exists(): raise FileExistsError('Use a new benchmark label to preserve existing samples')
 caps={'capabilities':{'alwaysMatch':{'browserName':'chrome','goog:chromeOptions':{'binary':os.environ['UWA_CHROME_BINARY'],'args':['--headless=new','--no-sandbox','--window-size=1280,900','--use-angle=vulkan','--enable-features=Vulkan','--disable-vulkan-surface','--ignore-gpu-blocklist'],'prefs':{'download.default_directory':'/tmp/uwa-downloads'}},'goog:loggingPrefs':{'browser':'ALL'}}}}
 s=req('/session',caps); sid=s['sessionId']; root='/session/'+sid
 def js(script):return req(root+'/execute/sync',{'script':script,'args':[]})
 try:
  req(root+'/url',{'url':os.environ.get('UWA_BENCH_URL','http://127.0.0.1:8023/index.html?uwaReconWorkers=2')})
  for i in range(60):
   time.sleep(1)
   if js("return typeof window.loadBundledDemoScene==='function' && document.body.innerText.includes('Workers fully ready');"):break
  if not js("return document.getElementById('worker-warmup-status')?.dataset.state==='ready'"): raise RuntimeError('Worker warmup did not complete')
  print('ENV',js("let g=document.createElement('canvas').getContext('webgl2'),e=g?.getExtension('WEBGL_debug_renderer_info');return {renderer:e?g.getParameter(e.UNMASKED_RENDERER_WEBGL):null,iso:crossOriginIsolated,warmup:document.getElementById('worker-warmup-status')?.dataset.state}"),flush=True)
  js("window.__benchReport=null;const orig=URL.createObjectURL;URL.createObjectURL=function(b){if(b.type?.includes('json'))b.text().then(t=>window.__benchReport=t);return orig.call(this,b)}; document.querySelector('[data-bundled-scene-id=library]').click();return true;")
  for i in range(120):
   time.sleep(1)
   if js("return [...document.querySelectorAll('button')].some(b=>b.textContent==='Download timing JSON');"): break
   if i%20==0: print('WAIT',i,js('return document.body.innerText.slice(-600)'),flush=True)
  js("[...document.querySelectorAll('button')].find(b=>b.textContent==='Download timing JSON')?.click();return true")
  time.sleep(.5); raw=js('return window.__benchReport');
  if not raw:raise RuntimeError('No timing report: '+str(js('return document.body.innerText.slice(-2000)')))
  d=json.loads(raw)
  assert d['status']=='complete', 'Timing collection was incomplete'
  assert d['config']['timingOrigin']=='decode-start', 'Unexpected timing origin'
  assert d['loading']['firstFrameMetrics']['firstFrameScope']=='full', 'Expected the complete scene'
  assert d['loading']['firstFrameMetrics']['renderedPointCount']>0, 'No rendered splats'
  (out/f'{label}-{run+1}.json').write_text(raw)
  if run==0:(out/f'{label}.png').write_bytes(base64.b64decode(req(root+'/screenshot',method='GET')))
  (out/f'{label}-{run+1}-console.json').write_text(json.dumps(req(root+'/log',{'type':'browser'})))
  w=d['splatBuffer']['allUwaLoadTimings'][0]['workerTimings']; print('RESULT',label,run+1,json.dumps({'first':d['loading']['firstFrameMetrics']['totalDecodeStartToFirstSplatFrameMs'],'pack':w['packShardMs'],'recon':w['wall']['reconstructionWallMs'],'dispatch':w['dispatch'],'video':w['prepare']['videoDecoderPath']}),flush=True)
 finally:req(root,method='DELETE')
