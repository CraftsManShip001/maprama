/* Throwaway probe app: does HTTP Range work (a) on the React Native JS thread
   and (b) inside react-native-webview loaded exactly the way Maprama loads its
   engine — source={{ html }}, i.e. an opaque origin? */
import React, { useEffect, useState } from 'react';
import { Platform, ScrollView, Text, View } from 'react-native';
import { WebView } from 'react-native-webview';

const HOST = Platform.OS === 'android' ? 'http://10.0.2.2' : 'http://localhost';
const ORIGIN = HOST + ':8791';
const CDN_OK = HOST + ':8792';
const CDN_NARROW = HOST + ':8793';

const expected = (i) => (i * 31 + 7) % 251;

async function rnTests(push) {
  push('platform', true, Platform.OS + ' rn-fetch');

  // 1. fetch + arrayBuffer
  try {
    const res = await fetch(ORIGIN + '/blob.bin', { headers: { Range: 'bytes=1000-1099' } });
    const ab = await res.arrayBuffer();
    const u8 = new Uint8Array(ab);
    const ok = res.status === 206 && u8.length === 100 && u8[0] === expected(1000) && u8[99] === expected(1099);
    push('RN fetch + arrayBuffer', ok,
      'status=' + res.status + ' len=' + u8.length + ' cr=' + res.headers.get('content-range') +
      ' first=' + u8[0] + '/' + expected(1000));
  } catch (e) { push('RN fetch + arrayBuffer', false, 'threw: ' + String(e && e.message || e)); }

  // 2. fetch cross "origin" with narrow CORS - RN has no CORS, should still work
  try {
    const res = await fetch(CDN_NARROW + '/blob.bin', { headers: { Range: 'bytes=2048-2175' } });
    const ab = await res.arrayBuffer();
    push('RN fetch narrow-CORS host', res.status === 206 && ab.byteLength === 128,
      'status=' + res.status + ' len=' + ab.byteLength + ' cr=' + res.headers.get('content-range'));
  } catch (e) { push('RN fetch narrow-CORS host', false, 'threw: ' + String(e && e.message || e)); }

  // 3. XHR with responseType arraybuffer
  await new Promise((resolve) => {
    try {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', ORIGIN + '/blob.bin');
      xhr.responseType = 'arraybuffer';
      xhr.setRequestHeader('Range', 'bytes=4194304-4194559');
      xhr.onload = () => {
        const u8 = new Uint8Array(xhr.response || new ArrayBuffer(0));
        push('RN XHR arraybuffer', xhr.status === 206 && u8.length === 256 && u8[0] === expected(4194304),
          'status=' + xhr.status + ' len=' + u8.length + ' first=' + u8[0] + '/' + expected(4194304));
        resolve();
      };
      xhr.onerror = () => { push('RN XHR arraybuffer', false, 'onerror'); resolve(); };
      xhr.send();
    } catch (e) { push('RN XHR arraybuffer', false, 'threw: ' + String(e && e.message || e)); resolve(); }
  });

  // 4. timing: 16 sequential 64 KB ranges (what a tile fetch burst costs)
  try {
    const t0 = Date.now();
    let bytes = 0;
    for (let i = 0; i < 16; i++) {
      const s = i * 65536;
      const res = await fetch(ORIGIN + '/blob.bin', { headers: { Range: 'bytes=' + s + '-' + (s + 65535) } });
      bytes += (await res.arrayBuffer()).byteLength;
    }
    push('RN 16x64KB sequential', bytes === 16 * 65536, bytes + ' B in ' + (Date.now() - t0) + ' ms');
  } catch (e) { push('RN 16x64KB sequential', false, 'threw: ' + String(e && e.message || e)); }
}

const WEBVIEW_HTML = `<!doctype html><meta charset="utf-8"><body><script>
const ORIGIN=${JSON.stringify(ORIGIN)},CDN_OK=${JSON.stringify(CDN_OK)},CDN_NARROW=${JSON.stringify(CDN_NARROW)};
const exp=(i)=>(i*31+7)%251;
const out=[];
function push(n,ok,d){out.push({name:'[webview] '+n,ok:ok,detail:d});}
async function rt(name,url,header,wantLen){
  try{
    const res=await fetch(url,{headers:{Range:header},cache:'no-store'});
    const u8=new Uint8Array(await res.arrayBuffer());
    push(name,res.status===206&&u8.length===wantLen,'status='+res.status+' len='+u8.length+' cr='+res.headers.get('Content-Range'));
  }catch(e){push(name,false,'threw: '+(e&&e.message||e));}
}
(async()=>{
  push('origin',true,'document.origin='+String(document.location.origin)+' href='+String(document.location.href).slice(0,40));
  await rt('same-host range',ORIGIN+'/blob.bin','bytes=1000-1099',100);
  await rt('cdn CORS ok',CDN_OK+'/blob.bin','bytes=2048-2175',128);
  await rt('cdn CORS narrow',CDN_NARROW+'/blob.bin','bytes=2048-2175',128);
  try{
    const res=await fetch(ORIGIN+'/tile.gz',{cache:'no-store'});
    const gz=await res.arrayBuffer();
    const ds=new DecompressionStream('gzip');
    const plain=new Uint8Array(await new Response(new Blob([gz]).stream().pipeThrough(ds)).arrayBuffer());
    const magic=String.fromCharCode(plain[0],plain[1],plain[2],plain[3]);
    push('gunzip MTIL tile',magic==='MTIL','DecompressionStream='+typeof DecompressionStream+' gz='+gz.byteLength+' plain='+plain.length+' magic='+magic);
  }catch(e){push('gunzip MTIL tile',false,'threw: '+(e&&e.message||e));}
  try{
    const t0=Date.now();
    const parts=await Promise.all(Array.from({length:8},(_,i)=>{const s=100000+i*5000;
      return fetch(ORIGIN+'/blob.bin',{headers:{Range:'bytes='+s+'-'+(s+4999)},cache:'no-store'}).then(r=>r.arrayBuffer().then(b=>b.byteLength));}));
    push('8 concurrent ranges',parts.every(n=>n===5000),parts.join(',')+' in '+(Date.now()-t0)+' ms');
  }catch(e){push('8 concurrent ranges',false,'threw: '+(e&&e.message||e));}
  window.ReactNativeWebView.postMessage(JSON.stringify(out));
})();
<\/script></body>`;

export default function App() {
  const [lines, setLines] = useState([]);
  const push = (name, ok, detail) => setLines((l) => [...l, { name, ok, detail }]);

  useEffect(() => { rnTests(push); }, []);

  useEffect(() => {
    if (lines.length >= 5 + 6) {
      fetch(ORIGIN + '/report', { method: 'POST', body: JSON.stringify(lines) }).catch(() => {});
    }
  }, [lines]);

  return (
    <View style={{ flex: 1, paddingTop: 60 }}>
      <ScrollView style={{ flex: 1, padding: 8 }}>
        {lines.map((l, i) => (
          <Text key={i} style={{ color: l.ok ? '#070' : '#c00', fontSize: 11, marginBottom: 4 }}>
            {(l.ok ? 'PASS ' : 'FAIL ') + l.name + ' - ' + l.detail}
          </Text>
        ))}
      </ScrollView>
      <WebView
        style={{ height: 1, opacity: 0 }}
        source={{ html: WEBVIEW_HTML }}
        originWhitelist={['about:blank', 'about:srcdoc', 'data:*']}
        javaScriptEnabled
        mixedContentMode="always"
        onMessage={(e) => {
          try { for (const r of JSON.parse(e.nativeEvent.data)) push(r.name, r.ok, r.detail); }
          catch (err) { push('[webview] parse', false, String(err)); }
        }}
      />
    </View>
  );
}
