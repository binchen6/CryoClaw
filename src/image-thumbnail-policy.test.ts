import test from "node:test";
import assert from "node:assert/strict";
import {thumbnailDimensions} from "./image-thumbnail-policy";
test("thumbnail decoders are entered only for recognized bounded dimensions",()=>{
  const png=Buffer.alloc(24);Buffer.from([137,80,78,71,13,10,26,10]).copy(png);png.writeUInt32BE(640,16);png.writeUInt32BE(480,20);
  assert.deepEqual(thumbnailDimensions(png),{width:640,height:480});
  png.writeUInt32BE(8000,16);png.writeUInt32BE(6000,20);assert.deepEqual(thumbnailDimensions(png),{width:8000,height:6000});
  png.writeUInt32BE(100000,16);assert.equal(thumbnailDimensions(png),null);
  assert.equal(thumbnailDimensions(Buffer.from("<svg>unsafe or unsupported</svg>")),null);
  assert.equal(thumbnailDimensions(Buffer.alloc(3)),null);
});
