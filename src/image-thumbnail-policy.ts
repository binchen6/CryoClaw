/** Inspect bounded headers before entering native decoders; never allocate full image pixels here. */
export function thumbnailDimensions(header:Buffer):{width:number;height:number}|null {
  let width=0,height=0;
  if(header.length>=24 && header.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))){width=header.readUInt32BE(16);height=header.readUInt32BE(20);}
  else if(header.length>=10 && /^GIF8[79]a/.test(header.toString("ascii",0,6))){width=header.readUInt16LE(6);height=header.readUInt16LE(8);}
  else if(header.length>=26 && header.toString("ascii",0,2)==="BM"){width=Math.abs(header.readInt32LE(18));height=Math.abs(header.readInt32LE(22));}
  else if(header.length>=30 && header.toString("ascii",0,4)==="RIFF" && header.toString("ascii",8,12)==="WEBP"){
    if(header.toString("ascii",12,16)==="VP8X"){width=1+header.readUIntLE(24,3);height=1+header.readUIntLE(27,3);}
    else {const offset=header.indexOf(Buffer.from([157,1,42]),20);if(offset>=0 && offset+7<=header.length){width=header.readUInt16LE(offset+3)&16383;height=header.readUInt16LE(offset+5)&16383;}}
  } else if(header.length>=4 && header[0]===255 && header[1]===216){
    let offset=2;
    while(offset+4<header.length){if(header[offset]!==255){offset++;continue;}const marker=header[offset+1];if(marker===255){offset++;continue;}
      if(marker===216 || marker>=208 && marker<=215){offset+=2;continue;}const length=header.readUInt16BE(offset+2);if(length<2)break;
      if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker) && length>=7 && offset+9<=header.length){height=header.readUInt16BE(offset+5);width=header.readUInt16BE(offset+7);break;}offset+=length+2;
    }
  }
  return width>0 && height>0 && width<=16384 && height<=16384 && width*height<=64_000_000?{width,height}:null;
}
