## Install:
```
npm install https://github.com/ThaUnknown/wt-gdrive-webseed
```
## External:
```html
<script src="https://apis.google.com/js/api.js"></script>
```
## Usage:
```js
import { gDHandleTorrent, init } from 'wt-gdrive-webseed'
import WebTorrent from 'webtorrent'

const client = new WebTorrent()

init({ apiKey, clientId, DiscoveryDocs, scope }) // creates a oauth popup for google login

client.on('torrent', gDHandleTorrent) // tries finding a file, does nothing if it can't find one
```