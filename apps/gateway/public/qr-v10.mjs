// Fixed QR Code Model 2 encoder for Mobile Entry pairing payloads.
// Version 20-L, byte mode, mask 0. No network or third-party runtime dependency.

const VERSION = 20;
const SIZE = 97;
const DATA_CODEWORDS = 861;
const TOTAL_CODEWORDS = 1085;
const ALIGNMENT_POSITIONS = [6, 34, 62, 90];
const BLOCK_SPECS = [
  { total: 135, data: 107 },
  { total: 135, data: 107 },
  { total: 135, data: 107 },
  { total: 136, data: 108 },
  { total: 136, data: 108 },
  { total: 136, data: 108 },
  { total: 136, data: 108 },
  { total: 136, data: 108 }
];

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
  let value = 1;
  for (let index = 0; index < 255; index += 1) {
    GF_EXP[index] = value;
    GF_LOG[value] = index;
    value <<= 1;
    if ((value & 0x100) !== 0) value ^= 0x11d;
  }
  for (let index = 255; index < GF_EXP.length; index += 1) {
    GF_EXP[index] = GF_EXP[index - 255];
  }
}

function multiply(left, right) {
  if (left === 0 || right === 0) return 0;
  return GF_EXP[GF_LOG[left] + GF_LOG[right]];
}

function generatorPolynomial(degree) {
  let polynomial = [1];
  for (let exponent = 0; exponent < degree; exponent += 1) {
    const next = new Array(polynomial.length + 1).fill(0);
    for (let index = 0; index < polynomial.length; index += 1) {
      next[index] ^= polynomial[index];
      next[index + 1] ^= multiply(polynomial[index], GF_EXP[exponent]);
    }
    polynomial = next;
  }
  return polynomial;
}

function errorCorrection(data, degree) {
  const generator = generatorPolynomial(degree);
  let remainder = new Array(degree).fill(0);
  for (const value of data) {
    const factor = value ^ remainder[0];
    remainder = remainder.slice(1);
    remainder.push(0);
    for (let index = 0; index < degree; index += 1) {
      remainder[index] ^= multiply(generator[index + 1], factor);
    }
  }
  return remainder;
}

function appendBits(target, value, length) {
  for (let shift = length - 1; shift >= 0; shift -= 1) {
    target.push((value >>> shift) & 1);
  }
}

function dataCodewords(value) {
  const bytes = new TextEncoder().encode(value);
  const bits = [];
  appendBits(bits, 0b0100, 4);
  appendBits(bits, bytes.length, 16);
  for (const byte of bytes) appendBits(bits, byte, 8);

  const capacity = DATA_CODEWORDS * 8;
  if (bits.length > capacity) {
    throw new RangeError("Mobile pairing QR payload exceeds Version 20-L capacity");
  }
  for (let count = 0; count < Math.min(4, capacity - bits.length); count += 1) {
    bits.push(0);
  }
  while (bits.length % 8 !== 0) bits.push(0);

  const codewords = [];
  for (let offset = 0; offset < bits.length; offset += 8) {
    let byte = 0;
    for (let bit = 0; bit < 8; bit += 1) byte |= bits[offset + bit] << (7 - bit);
    codewords.push(byte);
  }
  for (let index = 0; codewords.length < DATA_CODEWORDS; index += 1) {
    codewords.push(index % 2 === 0 ? 0xec : 0x11);
  }
  return codewords;
}

function interleavedCodewords(value) {
  const data = dataCodewords(value);
  const blocks = [];
  const correctionBlocks = [];
  let offset = 0;
  for (const spec of BLOCK_SPECS) {
    const block = data.slice(offset, offset + spec.data);
    offset += spec.data;
    blocks.push(block);
    correctionBlocks.push(errorCorrection(block, spec.total - spec.data));
  }

  const result = [];
  const maxDataLength = Math.max(...blocks.map((block) => block.length));
  for (let index = 0; index < maxDataLength; index += 1) {
    for (const block of blocks) if (index < block.length) result.push(block[index]);
  }
  const maxCorrectionLength = Math.max(...correctionBlocks.map((block) => block.length));
  for (let index = 0; index < maxCorrectionLength; index += 1) {
    for (const block of correctionBlocks) result.push(block[index]);
  }
  if (result.length !== TOTAL_CODEWORDS) throw new Error("Unexpected QR codeword count");
  return result;
}

function bchDigit(value) {
  let digits = 0;
  while (value !== 0) {
    digits += 1;
    value >>>= 1;
  }
  return digits;
}

function formatBits(mask) {
  const generator = 0x537;
  const formatMask = 0x5412;
  const data = (1 << 3) | mask;
  let remainder = data << 10;
  while (bchDigit(remainder) - bchDigit(generator) >= 0) {
    remainder ^= generator << (bchDigit(remainder) - bchDigit(generator));
  }
  return ((data << 10) | remainder) ^ formatMask;
}

function versionBits() {
  const generator = 0x1f25;
  let remainder = VERSION << 12;
  while (bchDigit(remainder) - bchDigit(generator) >= 0) {
    remainder ^= generator << (bchDigit(remainder) - bchDigit(generator));
  }
  return (VERSION << 12) | remainder;
}

function maskApplies(row, column) {
  return (row + column) % 2 === 0;
}

export function createQrMatrix(value) {
  const modules = Array.from({ length: SIZE }, () => new Array(SIZE).fill(null));
  const functionModules = Array.from({ length: SIZE }, () => new Array(SIZE).fill(false));

  const setFunction = (row, column, dark) => {
    if (row < 0 || row >= SIZE || column < 0 || column >= SIZE) return;
    modules[row][column] = Boolean(dark);
    functionModules[row][column] = true;
  };

  for (const [centerRow, centerColumn] of [
    [3, 3],
    [3, SIZE - 4],
    [SIZE - 4, 3]
  ]) {
    for (let rowOffset = -4; rowOffset <= 4; rowOffset += 1) {
      for (let columnOffset = -4; columnOffset <= 4; columnOffset += 1) {
        const distance = Math.max(Math.abs(rowOffset), Math.abs(columnOffset));
        setFunction(
          centerRow + rowOffset,
          centerColumn + columnOffset,
          distance !== 2 && distance !== 4
        );
      }
    }
  }

  for (const row of ALIGNMENT_POSITIONS) {
    for (const column of ALIGNMENT_POSITIONS) {
      if (modules[row][column] !== null) continue;
      for (let rowOffset = -2; rowOffset <= 2; rowOffset += 1) {
        for (let columnOffset = -2; columnOffset <= 2; columnOffset += 1) {
          setFunction(
            row + rowOffset,
            column + columnOffset,
            Math.max(Math.abs(rowOffset), Math.abs(columnOffset)) !== 1
          );
        }
      }
    }
  }

  for (let index = 8; index < SIZE - 8; index += 1) {
    if (modules[index][6] === null) setFunction(index, 6, index % 2 === 0);
    if (modules[6][index] === null) setFunction(6, index, index % 2 === 0);
  }

  const encodedVersion = versionBits();
  for (let index = 0; index < 18; index += 1) {
    const dark = ((encodedVersion >>> index) & 1) !== 0;
    setFunction(Math.floor(index / 3), index % 3 + SIZE - 11, dark);
    setFunction(index % 3 + SIZE - 11, Math.floor(index / 3), dark);
  }

  const encodedFormat = formatBits(0);
  for (let index = 0; index < 15; index += 1) {
    const dark = ((encodedFormat >>> index) & 1) !== 0;
    if (index < 6) setFunction(index, 8, dark);
    else if (index < 8) setFunction(index + 1, 8, dark);
    else setFunction(SIZE - 15 + index, 8, dark);
  }
  for (let index = 0; index < 15; index += 1) {
    const dark = ((encodedFormat >>> index) & 1) !== 0;
    if (index < 8) setFunction(8, SIZE - index - 1, dark);
    else if (index < 9) setFunction(8, 15 - index, dark);
    else setFunction(8, 15 - index - 1, dark);
  }
  setFunction(SIZE - 8, 8, true);

  const bits = [];
  for (const codeword of interleavedCodewords(value)) appendBits(bits, codeword, 8);
  let bitIndex = 0;
  let row = SIZE - 1;
  let direction = -1;
  for (let column = SIZE - 1; column > 0; column -= 2) {
    if (column === 6) column -= 1;
    while (true) {
      for (const currentColumn of [column, column - 1]) {
        if (!functionModules[row][currentColumn]) {
          let dark = bitIndex < bits.length ? bits[bitIndex] === 1 : false;
          bitIndex += 1;
          if (maskApplies(row, currentColumn)) dark = !dark;
          modules[row][currentColumn] = dark;
        }
      }
      row += direction;
      if (row < 0 || row >= SIZE) {
        row -= direction;
        direction = -direction;
        break;
      }
    }
  }

  if (modules.some((moduleRow) => moduleRow.some((module) => module === null))) {
    throw new Error("QR matrix contains unassigned modules");
  }
  return modules;
}

export function createQrSvg(value, options = {}) {
  const matrix = createQrMatrix(value);
  const quietZone = options.quietZone ?? 4;
  const dimension = SIZE + quietZone * 2;
  const paths = [];
  for (let row = 0; row < SIZE; row += 1) {
    for (let column = 0; column < SIZE; column += 1) {
      if (matrix[row][column]) paths.push(`M${column + quietZone},${row + quietZone}h1v1h-1z`);
    }
  }
  const title = String(options.title ?? "iPhone 配对二维码")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dimension} ${dimension}" role="img" aria-label="${title}" shape-rendering="crispEdges"><title>${title}</title><rect width="100%" height="100%" fill="#fff"/><path d="${paths.join("")}" fill="#000"/></svg>`;
}
