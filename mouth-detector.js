// Disposable inference context. The caller destroys this frame after one image.
import {FaceLandmarker,FilesetResolver} from './vendor/mouth/vision_bundle.mjs';
window.addEventListener('message',async e=>{
  if(e.source!==parent || typeof e.data?.token!=='string' || !(e.data.bitmap instanceof ImageBitmap))return;
  const {token,bitmap}=e.data;let detector;
  try {
    const wasm=await FilesetResolver.forVisionTasks('./vendor/mouth/wasm');
    detector=await FaceLandmarker.createFromOptions(wasm,{baseOptions:{modelAssetPath:'./vendor/mouth/face_landmarker.task',delegate:'CPU'},runningMode:'IMAGE',numFaces:1,outputFaceBlendshapes:false,outputFacialTransformationMatrixes:false});
    const p=detector.detect(bitmap).faceLandmarks?.[0];let rig=null;
    if(p){const a=p[61],b=p[291],upper=p[13],lower=p[14];rig={v:1,x:(upper.x+lower.x)/2,y:(upper.y+lower.y)/2,w:Math.hypot(b.x-a.x,b.y-a.y),h:Math.hypot(lower.x-upper.x,lower.y-upper.y),angle:Math.atan2(b.y-a.y,b.x-a.x),strength:.13};}
    parent.postMessage({token,rig},'*');
  } catch(e) {parent.postMessage({token,error:e.message||'Не удалось найти лицо'},'*');}
  finally {detector?.close();bitmap.close();}
},{once:true});
