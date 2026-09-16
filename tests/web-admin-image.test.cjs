const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { imageInput, MAX_IMAGE_BYTES } = require('../cloudfunctions/marketApi/webAdminContent')

function segment(marker, body) {
  const header = Buffer.from([0xff, marker, 0, 0])
  header.writeUInt16BE(body.length + 2, 2)
  return Buffer.concat([header, Buffer.from(body)])
}
// A minimal grayscale JPEG marker stream: quantization/Huffman tables,
// one-pixel frame and a scan. Tests exercise container validation, not decoding.
const frame = marker => segment(marker, [8, 0, 1, 0, 1, 1, 1, 0x11, 0])
const scan = () => segment(0xda, [1, 1, 0, 0, 63, 0])
function jpeg({ progressive = false, metadata = [], entropy = [0x3f], trailer = [] } = {}) {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    segment(0xe1, metadata),
    segment(0xdb, [0, ...Array(64).fill(1)]),
    frame(progressive ? 0xc2 : 0xc0),
    segment(0xc4, [0, 1, ...Array(15).fill(0), 0, 0x10, 1, ...Array(15).fill(0), 0]),
    scan(), Buffer.from(entropy),
    ...(progressive ? [scan(), Buffer.from([0x3f])] : []),
    Buffer.from([0xff, 0xd9]), Buffer.from(trailer)
  ])
}
const input = bytes => ({ purpose: 'community', filename: 'contact.jpg', contentType: 'image/jpeg', base64: bytes.toString('base64') })
const rejected = bytes => assert.throws(() => imageInput(input(bytes)), /invalid_image/)

test('JPEG upload accepts WeChat trailing metadata and preserves every byte and the content hash', () => {
  const trailer = Buffer.from('3a61631000000000da66c99c610bbed8555e240b9828df1d', 'hex')
  for (const bytes of [jpeg(), jpeg({ trailer }), jpeg({ progressive: true, trailer })]) {
    const result = imageInput(input(bytes))
    assert.equal(result.ext, 'jpg')
    assert.deepEqual(result.bytes, bytes)
    assert.equal(result.contentHash, crypto.createHash('sha256').update(bytes).digest('hex'))
  }
})

test('JPEG validation respects metadata segment lengths, escaped scan bytes and restart markers', () => {
  const bytes = jpeg({ metadata: [0xff, 0xd9], entropy: [1, 0xff, 0, 2, 0xff, 0xd0, 3, 0xff, 0xff, 0xd1, 4] })
  assert.deepEqual(imageInput(input(bytes)).bytes, bytes)
  // A fake EOI inside APP metadata cannot make a truncated image valid.
  rejected(bytes.subarray(0, bytes.length - 2))
})

test('JPEG upload rejects missing image data, forged magic bytes and invalid segment boundaries', () => {
  const valid = jpeg()
  const fake = Buffer.alloc(200, 0x41)
  fake[0] = 0xff; fake[1] = 0xd8; fake[2] = 0xff
  fake[fake.length - 2] = 0xff; fake[fake.length - 1] = 0xd9
  for (const bytes of [
    fake,
    Buffer.concat([Buffer.from([0xff, 0xd8]), segment(0xe1, [1, 2, 3]), Buffer.from([0xff, 0xd9])]),
    jpeg({ entropy: [] }),
    valid.subarray(0, valid.length - 1),
    valid.subarray(0, valid.length - 2),
    Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff]), valid]),
    Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 1]), valid]),
    Buffer.concat([valid, Buffer.alloc(MAX_IMAGE_BYTES)])
  ]) rejected(bytes)
})

test('JPEG upload requires valid dimensions and scan components declared by the frame', () => {
  const valid = jpeg()
  const frameOffset = valid.indexOf(Buffer.from([0xff, 0xc0]))
  const scanOffset = valid.indexOf(Buffer.from([0xff, 0xda]))
  for (const [offset, value] of [[frameOffset + 8, 0], [frameOffset + 9, 0], [frameOffset + 11, 0], [scanOffset + 4, 0], [scanOffset + 5, 2]]) {
    const invalid = Buffer.from(valid)
    invalid[offset] = value
    rejected(invalid)
  }
})
