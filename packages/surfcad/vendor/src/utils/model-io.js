// utils/model-io.js
// Core 3D file parsing and export utilities

// ============================================================================
// STL IMPORT
// ============================================================================

/**
 * Parse STL file (auto-detects binary vs ASCII)
 * @param {File|ArrayBuffer} file
 * @returns {Promise<{vertices: number[][], triangles: number[][]}>}
 */
export async function importSTL(file) {
  const buffer = file instanceof ArrayBuffer ? file : await file.arrayBuffer();
  
  // Detect binary vs ASCII
  if (isSTLBinary(buffer)) {
    return parseSTLBinary(buffer);
  } else {
    const text = new TextDecoder().decode(buffer);
    return parseSTLAscii(text);
  }
}

function isSTLBinary(buffer) {
  if (buffer.byteLength < 84) return false;
  
  const header = new Uint8Array(buffer, 0, 80);
  const headerStr = String.fromCharCode(...header).toLowerCase();
  
  // If doesn't start with "solid", it's binary
  if (!headerStr.startsWith('solid')) return true;
  
  // Validate binary size
  const view = new DataView(buffer);
  const numTriangles = view.getUint32(80, true);
  const expectedSize = 84 + numTriangles * 50;
  
  return buffer.byteLength === expectedSize;
}

function parseSTLBinary(buffer) {
  const view = new DataView(buffer);
  const numTriangles = view.getUint32(80, true);
  
  const vertices = [];
  const triangles = [];
  let offset = 84;
  
  for (let i = 0; i < numTriangles; i++) {
    offset += 12; // Skip normal
    
    const baseIdx = vertices.length;
    
    for (let v = 0; v < 3; v++) {
      const x = view.getFloat32(offset, true); offset += 4;
      const y = view.getFloat32(offset, true); offset += 4;
      const z = view.getFloat32(offset, true); offset += 4;
      vertices.push([x, y, z]);
    }
    
    triangles.push([baseIdx, baseIdx + 1, baseIdx + 2]);
    offset += 2; // Skip attribute
  }
  
  return { vertices, triangles };
}

function parseSTLAscii(text) {
  const vertices = [];
  const triangles = [];
  
  const lines = text.split('\n');
  let currentTri = [];
  
  for (const line of lines) {
    const trimmed = line.trim().toLowerCase();
    
    if (trimmed.startsWith('vertex ')) {
      const parts = trimmed.split(/\s+/);
      vertices.push([
        parseFloat(parts[1]),
        parseFloat(parts[2]),
        parseFloat(parts[3])
      ]);
      currentTri.push(vertices.length - 1);
    } else if (trimmed === 'endfacet') {
      if (currentTri.length === 3) {
        triangles.push([...currentTri]);
      }
      currentTri = [];
    }
  }
  
  return { vertices, triangles };
}

// ============================================================================
// OBJ IMPORT
// ============================================================================

/**
 * Parse OBJ file
 * @param {File|string} file
 * @returns {Promise<{vertices: number[][], triangles: number[][]}>}
 */
export async function importOBJ(file) {
  const text = typeof file === 'string' ? file : await file.text();
  return parseOBJ(text);
}

function parseOBJ(text) {
  const vertices = [];
  const triangles = [];
  
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    
    const parts = trimmed.split(/\s+/);
    const cmd = parts[0];
    
    if (cmd === 'v') {
      vertices.push([
        parseFloat(parts[1]) || 0,
        parseFloat(parts[2]) || 0,
        parseFloat(parts[3]) || 0
      ]);
    } else if (cmd === 'f') {
      const indices = [];
      for (let i = 1; i < parts.length; i++) {
        if (!parts[i]) continue;
        const idx = parseInt(parts[i].split('/')[0]);
        // OBJ is 1-indexed, can be negative
        indices.push(idx < 0 ? vertices.length + idx : idx - 1);
      }
      // Fan triangulation for polygons
      for (let i = 1; i < indices.length - 1; i++) {
        triangles.push([indices[0], indices[i], indices[i + 1]]);
      }
    }
  }
  
  return { vertices, triangles };
}

// ============================================================================
// 3MF IMPORT
// ============================================================================

/**
 * Parse 3MF file (ZIP containing XML)
 * @param {File|ArrayBuffer} file
 * @returns {Promise<{vertices: number[][], triangles: number[][]}>}
 */
export async function import3MF(file) {
  const buffer = file instanceof ArrayBuffer ? file : await file.arrayBuffer();
  const zipContents = await parseZip(buffer);
  
  // Find model XML
  let modelXML = null;
  
  // Check relationships for model path
  const rels = zipContents['_rels/.rels'];
  if (rels) {
    const relsText = new TextDecoder().decode(rels);
    const match = relsText.match(/Target="([^"]*\.model)"/i);
    if (match) {
      const path = match[1].replace(/^\//, '');
      if (zipContents[path]) {
        modelXML = new TextDecoder().decode(zipContents[path]);
      }
    }
  }
  
  // Try common paths
  if (!modelXML) {
    for (const path of ['3D/3dmodel.model', '3d/3dmodel.model']) {
      if (zipContents[path]) {
        modelXML = new TextDecoder().decode(zipContents[path]);
        break;
      }
    }
  }
  
  // Search for any .model file
  if (!modelXML) {
    for (const [path, content] of Object.entries(zipContents)) {
      if (path.endsWith('.model')) {
        modelXML = new TextDecoder().decode(content);
        break;
      }
    }
  }
  
  if (!modelXML) {
    throw new Error('No model file found in 3MF');
  }
  
  return parse3MFModel(modelXML);
}

function parse3MFModel(xml) {
  const vertices = [];
  const triangles = [];
  
  // Parse vertices - handle attribute order variations
  const vertexRegex = /<vertex[^>]+>/gi;
  let match;
  
  while ((match = vertexRegex.exec(xml)) !== null) {
    const tag = match[0];
    const x = tag.match(/x="([^"]+)"/i);
    const y = tag.match(/y="([^"]+)"/i);
    const z = tag.match(/z="([^"]+)"/i);
    
    if (x && y && z) {
      vertices.push([
        parseFloat(x[1]),
        parseFloat(y[1]),
        parseFloat(z[1])
      ]);
    }
  }
  
  // Parse triangles
  const triRegex = /<triangle[^>]+>/gi;
  
  while ((match = triRegex.exec(xml)) !== null) {
    const tag = match[0];
    const v1 = tag.match(/v1="(\d+)"/i);
    const v2 = tag.match(/v2="(\d+)"/i);
    const v3 = tag.match(/v3="(\d+)"/i);
    
    if (v1 && v2 && v3) {
      triangles.push([
        parseInt(v1[1]),
        parseInt(v2[1]),
        parseInt(v3[1])
      ]);
    }
  }
  
  if (vertices.length === 0 || triangles.length === 0) {
    throw new Error('No geometry found in 3MF');
  }
  
  return { vertices, triangles };
}

// ============================================================================
// MESH TO OBJ CONVERSION (Critical for import pipeline)
// ============================================================================

/**
 * Convert mesh data to OBJ format string
 * This allows using the reliable OBJ→Manifold pipeline for all imports
 * @param {{vertices: number[][], triangles: number[][]}} meshData
 * @param {string} name - Object name
 * @returns {string} OBJ format string
 */
export function meshToOBJ(meshData, name = 'imported') {
  const { vertices, triangles } = meshData;
  
  let obj = `# Converted mesh: ${name}\n`;
  obj += `# Vertices: ${vertices.length}, Faces: ${triangles.length}\n`;
  obj += `o ${name}\n\n`;
  
  // Write vertices
  for (const [x, y, z] of vertices) {
    obj += `v ${x} ${y} ${z}\n`;
  }
  
  obj += '\n';
  
  // Write faces (OBJ is 1-indexed)
  for (const [i0, i1, i2] of triangles) {
    obj += `f ${i0 + 1} ${i1 + 1} ${i2 + 1}\n`;
  }
  
  return obj;
}

/**
 * Convert Manifold mesh format to OBJ string
 * @param {{vertProperties: Float32Array|number[], triVerts: Uint32Array|number[], numProp?: number}} mesh
 * @param {string} name
 * @returns {string}
 */
export function manifoldMeshToOBJ(mesh, name = 'model') {
  const { vertProperties, triVerts, numProp = 3 } = mesh;
  
  const numVerts = Math.floor(vertProperties.length / numProp);
  const numTris = Math.floor(triVerts.length / 3);
  
  let obj = `# Manifold mesh: ${name}\n`;
  obj += `# Vertices: ${numVerts}, Faces: ${numTris}\n`;
  obj += `o ${name}\n\n`;
  
  // Write vertices
  for (let i = 0; i < numVerts; i++) {
    const x = vertProperties[i * numProp];
    const y = vertProperties[i * numProp + 1];
    const z = vertProperties[i * numProp + 2];
    obj += `v ${x} ${y} ${z}\n`;
  }
  
  obj += '\n';
  
  // Write faces (OBJ is 1-indexed)
  for (let i = 0; i < numTris; i++) {
    const i0 = triVerts[i * 3];
    const i1 = triVerts[i * 3 + 1];
    const i2 = triVerts[i * 3 + 2];
    obj += `f ${i0 + 1} ${i1 + 1} ${i2 + 1}\n`;
  }
  
  return obj;
}

// ============================================================================
// 3MF EXPORT
// ============================================================================

/**
 * Export Manifold mesh to 3MF blob
 * @param {{vertProperties: Float32Array|number[], triVerts: Uint32Array|number[], numProp?: number}} mesh
 * @param {string} modelName
 * @param {{unit?: string, title?: string, designer?: string}} options
 * @returns {Promise<Blob>}
 */
export async function export3MF(mesh, modelName = 'model', options = {}) {
  const { vertProperties, triVerts, numProp = 3 } = mesh;
  const unit = options.unit || 'millimeter';
  
  const numVerts = Math.floor(vertProperties.length / numProp);
  const numTris = Math.floor(triVerts.length / 3);
  
  // Build vertices XML
  let verticesXML = '';
  for (let i = 0; i < numVerts; i++) {
    const x = vertProperties[i * numProp];
    const y = vertProperties[i * numProp + 1];
    const z = vertProperties[i * numProp + 2];
    verticesXML += `        <vertex x="${x}" y="${y}" z="${z}"/>\n`;
  }
  
  // Build triangles XML
  let trianglesXML = '';
  for (let i = 0; i < numTris; i++) {
    const v1 = triVerts[i * 3];
    const v2 = triVerts[i * 3 + 1];
    const v3 = triVerts[i * 3 + 2];
    trianglesXML += `        <triangle v1="${v1}" v2="${v2}" v3="${v3}"/>\n`;
  }
  
  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>`;

  const rels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;

  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="${unit}" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <metadata name="Title">${options.title || modelName}</metadata>
  <metadata name="Designer">${options.designer || 'Manifold CAD'}</metadata>
  <metadata name="CreationDate">${new Date().toISOString()}</metadata>
  <resources>
    <object id="1" type="model" name="${modelName}">
      <mesh>
        <vertices>
${verticesXML}        </vertices>
        <triangles>
${trianglesXML}        </triangles>
      </mesh>
    </object>
  </resources>
  <build>
    <item objectid="1"/>
  </build>
</model>`;

  const zipData = await createZip({
    '[Content_Types].xml': contentTypes,
    '_rels/.rels': rels,
    '3D/3dmodel.model': model
  });
  
  return new Blob([zipData], { type: 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml' });
}

/**
 * Export mesh to 3MF and return as base64 string
 */
export async function export3MFBase64(mesh, modelName = 'model', options = {}) {
  const blob = await export3MF(mesh, modelName, options);
  return blobToBase64(blob);
}

// ============================================================================
// ZIP UTILITIES
// ============================================================================

async function parseZip(buffer) {
  const view = new DataView(buffer);
  const u8 = new Uint8Array(buffer);
  const files = {};
  
  // Find EOCD
  let eocdOffset = -1;
  for (let i = buffer.byteLength - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  
  if (eocdOffset === -1) throw new Error('Invalid ZIP');
  
  const cdOffset = view.getUint32(eocdOffset + 16, true);
  const numEntries = view.getUint16(eocdOffset + 10, true);
  
  let offset = cdOffset;
  
  for (let i = 0; i < numEntries; i++) {
    if (view.getUint32(offset, true) !== 0x02014b50) break;
    
    const compression = view.getUint16(offset + 10, true);
    const compSize = view.getUint32(offset + 20, true);
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    
    const name = new TextDecoder().decode(u8.slice(offset + 46, offset + 46 + nameLen));
    offset += 46 + nameLen + extraLen + commentLen;
    
    if (name.endsWith('/')) continue;
    
    // Read local header
    const localNameLen = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    const dataOffset = localOffset + 30 + localNameLen + localExtraLen;
    
    if (compression === 0) {
      files[name] = u8.slice(dataOffset, dataOffset + compSize);
    } else if (compression === 8) {
      files[name] = await inflate(u8.slice(dataOffset, dataOffset + compSize));
    }
  }
  
  return files;
}

async function inflate(data) {
  if (typeof DecompressionStream !== 'undefined') {
    try {
      const ds = new DecompressionStream('deflate-raw');
      const writer = ds.writable.getWriter();
      writer.write(data);
      writer.close();
      
      const chunks = [];
      const reader = ds.readable.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      
      const totalLen = chunks.reduce((s, c) => s + c.length, 0);
      const result = new Uint8Array(totalLen);
      let pos = 0;
      for (const chunk of chunks) {
        result.set(chunk, pos);
        pos += chunk.length;
      }
      return result;
    } catch (e) {
      console.warn('DecompressionStream failed:', e);
    }
  }
  
  // Fallback: throw - browser should support DecompressionStream
  throw new Error('Decompression not supported in this browser');
}

async function createZip(files) {
  const entries = [];
  const chunks = [];
  let offset = 0;
  
  for (const [name, content] of Object.entries(files)) {
    const data = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    const crc = crc32(data);
    
    entries.push({ name, data, crc, offset });
    
    const nameBytes = new TextEncoder().encode(name);
    const header = new ArrayBuffer(30 + nameBytes.length);
    const hv = new DataView(header);
    
    hv.setUint32(0, 0x04034b50, true);
    hv.setUint16(4, 20, true);
    hv.setUint32(14, crc, true);
    hv.setUint32(18, data.length, true);
    hv.setUint32(22, data.length, true);
    hv.setUint16(26, nameBytes.length, true);
    
    const hBytes = new Uint8Array(header);
    hBytes.set(nameBytes, 30);
    
    chunks.push(hBytes, data);
    offset += hBytes.length + data.length;
  }
  
  const cdStart = offset;
  
  for (const e of entries) {
    const nameBytes = new TextEncoder().encode(e.name);
    const cd = new ArrayBuffer(46 + nameBytes.length);
    const cv = new DataView(cd);
    
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint32(16, e.crc, true);
    cv.setUint32(20, e.data.length, true);
    cv.setUint32(24, e.data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, e.offset, true);
    
    const cdBytes = new Uint8Array(cd);
    cdBytes.set(nameBytes, 46);
    
    chunks.push(cdBytes);
    offset += cdBytes.length;
  }
  
  const eocd = new ArrayBuffer(22);
  const ev = new DataView(eocd);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, offset - cdStart, true);
  ev.setUint32(16, cdStart, true);
  
  chunks.push(new Uint8Array(eocd));
  
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const result = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) {
    result.set(c, pos);
    pos += c.length;
  }
  
  return result.buffer;
}

function crc32(data) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ============================================================================
// UTILITIES
// ============================================================================

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export default {
  importSTL,
  importOBJ,
  import3MF,
  meshToOBJ,
  manifoldMeshToOBJ,
  export3MF,
  export3MFBase64,
  blobToBase64,
  downloadBlob
};
