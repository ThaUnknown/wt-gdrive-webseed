import BitField from 'bitfield'
import ltDontHave from 'lt_donthave'
import sha1 from 'simple-sha1'
import Wire from 'bittorrent-protocol'
import { load, client, auth2 } from 'gapi'

function concat (chunks, size) {
  if (!size) {
    size = 0
    let i = chunks.length || chunks.byteLength || 0
    while (i--) size += chunks[i].length
  }
  const b = new Uint8Array(size)
  let offset = 0
  for (let i = 0, l = chunks.length; i < l; i++) {
    const chunk = chunks[i]
    b.set(chunk, offset)
    offset += chunk.byteLength || chunk.length
  }

  return b
}

const sleep = t => new Promise(resolve => setTimeout(t, resolve))

class Queue {
  constructor () {
    this.queue = []
    this.destroyed = false
  }

  add (fn) {
    this.queue.push(fn)
    if (this.queue.length === 1 && !this.destroyed) this._next()
  }

  async _next () {
    const fn = this.queue[0]
    await fn()
    this._remove()
    if (this.queue.length && !this.destroyed) this._next()
  }

  _remove () {
    if (!this.destroyed) this.queue.shift()
  }

  destroy () {
    this.destroyed = true
    this.queue = null
  }
}

const RETRY_DELAY = 10000

let keys, token

// i'll fucking give you 'thenable', shitass callbacks
export function init (keysObj) {
  keys = keysObj
  token = new Promise(resolve => {
    load('client:auth2', () => {
      client.init(Object.assign({}, keys)).then(() => {
        const auth = auth2.getAuthInstance()
        if (!auth.isSignedIn.get()) auth.signIn()

        // Handle the initial sign-in state.
        if (auth.isSignedIn.get()) {
          resolve(auth.currentUser.get().getAuthResponse().access_token)
        } else {
          close()
        }
      })
    })
  })
}

async function getFileNameID (name) {
  return new Promise(resolve => {
    token.then(() => {
      client.drive.files.list({
        pageSize: 1,
        fields: 'files(id)',
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,
        corpora: 'allDrives',
        q: `name = '${name}'`
      }).then(res => {
        setTimeout(() => resolve(res?.result?.files?.length && res?.result?.files[0].id), 500)
      })
    })
  })
}

export async function gDHandleTorrent (torrent) {
  await token
  for await (const file of torrent.files) {
    const gDriveID = await getFileNameID(file.name)
    if (gDriveID) {
      file.gDriveID = gDriveID
    } else {
      return null // if a single entry doesnt exist, I can't create a reliable webseed
    }
  }
  torrent.addWebSeed(new WebConn(torrent))
}

class WebConn extends Wire {
  constructor (torrent) {
    super()

    this.connId = torrent.infoHash + ' gdrive' // Unique id to deduplicate web seeds
    this.webPeerId = sha1.sync(this.connId)
    this._torrent = torrent
    this.lastRequest = {}

    this.queue = new Queue()

    this._init()
  }

  _init () {
    this.setKeepAlive(true)

    this.use(ltDontHave())

    this.once('handshake', (infoHash, peerId) => {
      if (this.destroyed) return
      this.handshake(infoHash, this.webPeerId)
      const numPieces = this._torrent.pieces.length
      const bitfield = new BitField(numPieces)
      for (let i = 0; i <= numPieces; i++) {
        bitfield.set(i, true)
      }
      this.bitfield(bitfield)
    })

    this.once('interested', () => {
      this.unchoke()
    })

    this.on('request', (pieceIndex, offset, length, callback) => {
      this.queue.add(async () => await this.httpRequest(pieceIndex, offset, length, (err, data) => {
        if (err) {
          this.lt_donthave.donthave(pieceIndex)
          const retryTimeout = setTimeout(() => {
            if (this.destroyed) return

            this.have(pieceIndex)
          }, RETRY_DELAY)
          if (retryTimeout.unref) retryTimeout.unref()
        }

        callback(err, data)
      }))
    })
  }

  async httpRequest (pieceIndex, offset, length, cb) {
    const pieceOffset = pieceIndex * this._torrent.pieceLength
    const rangeStart = pieceOffset + offset
    const rangeEnd = rangeStart + length - 1
    const files = this._torrent.files
    let requests
    if (files.length <= 1) {
      requests = [{
        url: `https://www.googleapis.com/drive/v3/files/${files[0].gDriveID}?supportsAllDrives=true&alt=media&key=${keys.apiKey}`,
        start: rangeStart,
        end: rangeEnd
      }]
    } else {
      const requestedFiles = files.filter(file => file.offset <= rangeEnd && (file.offset + file.length) > rangeStart)
      if (requestedFiles.length < 1) {
        return cb(new Error('Could not find file corresponding to web seed range request'))
      }

      requests = requestedFiles.map(file => {
        const fileEnd = file.offset + file.length - 1
        const url = `https://www.googleapis.com/drive/v3/files/${file.gDriveID}?supportsAllDrives=true&alt=media&key=${keys.apiKey}`
        return {
          url,
          fileOffsetInRange: Math.max(file.offset - rangeStart, 0),
          start: Math.max(rangeStart - file.offset, 0),
          end: Math.min(fileEnd, rangeEnd - file.offset)
        }
      })
    }
    let numRequestsSucceeded = 0
    let hasError = false

    let ret
    if (requests.length > 1) {
      ret = Buffer.alloc(length)
    }

    let { res, reader, endRange, setSize, ctrl } = this.lastRequest
    for await (const request of requests) {
      const { url, start, end } = request
      function onResponse (res, data) {
        if (res.status < 200 || res.status >= 300) {
          if (hasError) return
          hasError = true
          return cb(new Error(`Unexpected HTTP status code ${res.status}`))
        }
        if (requests.length === 1) {
          cb(null, data)
        } else {
          data.copy(ret, request.fileOffsetInRange)
          if (++numRequestsSucceeded === requests.length) {
            cb(null, ret)
          }
        }
      }
      if (endRange !== start - 1) {
        async function * read (reader) { // <3 Endless
          let buffered = []
          let bufferedBytes = 0
          let done = false
          let size = 512
          const setSize = x => { size = x }
          yield setSize

          while (!done) {
            const it = await reader.read()
            done = it.done
            if (done) {
              yield concat(buffered, bufferedBytes)
              return
            } else {
              bufferedBytes += it.value.byteLength
              buffered.push(it.value)

              while (bufferedBytes >= size) {
                const b = concat(buffered)
                bufferedBytes -= size
                yield b.slice(0, size)
                buffered = [b.slice(size, b.length)]
              }
            }
          }
        }
        if (ctrl) ctrl.abort()
        sleep(500)
        ctrl = new AbortController()
        res = await fetch(url, {
          headers: {
            range: `bytes=${start}-`,
            authorization: 'Bearer ' + await token
          },
          signal: ctrl.signal
        })
        reader = read(res.body.getReader(), 1)
        setSize = (await reader.next()).value // lazy, but 1st yield is callback x)
      }
      endRange = end
      setSize(end - start + 1)
      onResponse(res, (await reader.next()).value)
    }
    this.lastRequest = { res, reader, endRange, setSize, ctrl }
  }

  destroy () {
    this.queue.destroy()
    super.destroy()
    this._torrent = null
  }
}
