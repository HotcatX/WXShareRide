const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const filename = path.resolve(__dirname, '../pages/market/marketPost/marketPost.js')
const source = fs.readFileSync(filename, 'utf8')
const plain = value => JSON.parse(JSON.stringify(value))

function fixture({ paths = ['photo-one.jpg', 'photo-two.jpg'], failCompress = () => false, failUpload = () => false } = {}) {
  const calls = { compress: [], upload: [], choose: [], patches: [], toasts: [] }
  let definition, counter = 0
  const wx = {
    async chooseMedia(options) { calls.choose.push(plain(options)); return { tempFiles: paths.map(tempFilePath => ({ tempFilePath })) } },
    compressImage(options) {
      calls.compress.push({ src: options.src, quality: options.quality })
      if (failCompress(options)) options.fail({ errMsg: 'fixture compression failure' })
      else options.success({ tempFilePath: options.src.replace(/\.jpg$/, '') + `-quality${options.quality}.jpg` })
    },
    cloud: {
      uploadFile(options) {
        const fileID = `cloud://fixture-env.bucket/${options.cloudPath}`
        const row = { cloudPath: options.cloudPath, filePath: options.filePath, fileID }
        calls.upload.push(row)
        if (failUpload(row)) options.fail({ errMsg: 'fixture upload failure' })
        else options.success({ fileID })
        return { onProgressUpdate(callback) { callback({ progress: 50 }); callback({ progress: 100 }) } }
      }
    },
    showToast(options) { calls.toasts.push(plain(options)) }
  }
  class Clock extends Date { static now() { return 1_800_000_000_000 + counter++ } }
  vm.runInNewContext(source, {
    wx, Date: Clock, console: { error() {} }, Page(value) { definition = value },
    require(name) {
      if (name === '../../../utils/error') return { showDataError() {} }
      assert.equal(name, '../../../utils/regionTree')
      return { normalizeUserRegion() { return {} } }
    }
  }, { filename })
  const page = { ...definition, data: plain(definition.data) }
  page.setData = function (patch) { calls.patches.push(plain(patch)); Object.assign(this.data, plain(patch)) }
  page.ensureLoginBeforePost = () => true
  return { page, calls }
}

test('each selected image is compressed once per output and the original and thumbnail paths upload unchanged', async () => {
  const { page, calls } = fixture()
  await page.onChooseImage()
  assert.deepEqual(calls.compress, [
    { src: 'photo-one.jpg', quality: 52 }, { src: 'photo-one.jpg', quality: 42 },
    { src: 'photo-two.jpg', quality: 52 }, { src: 'photo-two.jpg', quality: 42 }
  ])
  assert.equal(calls.upload.length, 4)
  for (const photo of ['photo-one', 'photo-two']) {
    const main = calls.upload.find(row => row.filePath === `${photo}-quality52.jpg`)
    const thumb = calls.upload.find(row => row.filePath === `${photo}-quality42.jpg`)
    assert.match(main.cloudPath, /^market\/\d+_[a-f0-9]+\.jpg$/)
    assert.match(thumb.cloudPath, /^market_thumb\/\d+_[a-f0-9]+\.jpg$/)
  }
  assert.deepEqual(page.data.images, ['photo-one.jpg', 'photo-two.jpg'])
  assert.equal(page.data.imageFileIDs.length, 2)
  assert.equal(page.data.thumbFileIDs.length, 2)
  assert.equal(page.data.imageFileID, page.data.imageFileIDs[0])
  assert.equal(page.data.thumbFileID, page.data.thumbFileIDs[0])
  assert.equal(page.data.imageUploading, false)
  assert.equal(page.data.imageUploadProgress, 100)
  assert.equal(page.data.imageUploadText, '已完成')
  assert.equal(calls.toasts.at(-1).title, '上传成功')
  assert.ok(calls.patches.filter(patch => 'imageUploadProgress' in patch)
    .every(patch => patch.imageUploadProgress >= 0 && patch.imageUploadProgress <= 100))
})

test('compression failure uses the original file for both uploads without a second thumbnail attempt', async () => {
  const { page, calls } = fixture({ paths: ['photo.jpg'], failCompress: () => true })
  await page.onChooseImage()
  assert.deepEqual(calls.compress, [{ src: 'photo.jpg', quality: 52 }, { src: 'photo.jpg', quality: 42 }])
  assert.equal(calls.upload.length, 2)
  assert.ok(calls.upload.every(row => row.filePath === 'photo.jpg'))
  assert.equal(page.data.imageFileIDs.length, 1)
  assert.equal(page.data.thumbFileIDs.length, 1)
  assert.equal(page.data.imageUploading, false)
  assert.equal(calls.toasts.at(-1).title, '上传成功')
})

test('either upload failing keeps that image out of the submitted pair and continues later images', async () => {
  for (const folder of ['market', 'market_thumb']) {
    const { page, calls } = fixture({ failUpload: row => row.filePath.startsWith('photo-one-') && row.cloudPath.startsWith(folder + '/') })
    await page.onChooseImage()
    assert.equal(calls.compress.length, 4)
    assert.equal(calls.upload.length, 4)
    assert.deepEqual(page.data.images, ['photo-two.jpg'])
    assert.equal(page.data.imageFileIDs.length, 1)
    assert.equal(page.data.thumbFileIDs.length, 1)
    assert.equal(page.data.imageFileIDs[0], calls.upload.find(row => row.filePath === 'photo-two-quality52.jpg').fileID)
    assert.equal(page.data.thumbFileIDs[0], calls.upload.find(row => row.filePath === 'photo-two-quality42.jpg').fileID)
    assert.equal(page.data.imageUploading, false)
    assert.equal(page.data.imageUploadText, '部分完成')
    assert.equal(calls.toasts.at(-1).title, '部分图片上传失败')
  }
})

test('existing images retain their order and the six-image limit still bounds compression and uploads', async () => {
  const { page, calls } = fixture()
  const existing = Array.from({ length: 5 }, (_, i) => `cloud://fixture-env.bucket/market/existing-${i}.jpg`)
  const thumbs = Array.from({ length: 5 }, (_, i) => `cloud://fixture-env.bucket/market_thumb/existing-${i}.jpg`)
  Object.assign(page.data, { images: [...existing], image: existing[0], imageFileID: existing[0], imageFileIDs: [...existing],
    thumbFileID: thumbs[0], thumbFileIDs: [...thumbs] })
  await page.onChooseImage()
  assert.deepEqual(calls.choose, [{ count: 1, mediaType: ['image'], sourceType: ['album', 'camera'], sizeType: ['compressed'] }])
  assert.equal(calls.compress.length, 2)
  assert.equal(calls.upload.length, 2)
  assert.deepEqual(page.data.imageFileIDs.slice(0, 5), existing)
  assert.deepEqual(page.data.thumbFileIDs.slice(0, 5), thumbs)
  assert.equal(page.data.imageFileIDs.length, 6)
  assert.equal(page.data.thumbFileIDs.length, 6)
  await page.onChooseImage()
  assert.equal(calls.choose.length, 1)
  assert.equal(calls.upload.length, 2)
  assert.equal(calls.toasts.at(-1).title, '最多上传6张')
})
