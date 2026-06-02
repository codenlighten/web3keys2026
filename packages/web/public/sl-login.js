// SmartLedger Login — third-party integration library.
//
//   <script src="https://wallet.smartledger.technology/sl-login.js"></script>
//   <script>
//     // Start a sign-in (e.g. from a "Sign in" button)
//     SLLogin.start({ app: 'My App' })
//
//     // On the redirect_uri page
//     SLLogin.checkCallback().then(result => {
//       if (result.status === 'ok') console.log('Signed in as', result.address)
//       else if (result.status === 'cancelled') console.log('User cancelled')
//       else if (result.status !== 'no_callback') console.error(result)
//     })
//   </script>
//
// Verification happens server-side via the wallet's /api/verify-login endpoint.
// Pass { verify: false } to checkCallback() to skip the network call and do your
// own crypto with bsv.Message.verify(payload, address, signature).

(function (global) {
  // The wallet authority defaults to wherever this script is hosted (so embedding
  // https://web3keys.com/sl-login.js makes web3keys.com the sign-in wallet). Override
  // per-call with opts.authority. Falls back to web3keys.com if the origin is unknown.
  var AUTHORITY = (function () {
    try {
      if (typeof document !== 'undefined' && document.currentScript && document.currentScript.src) {
        return new URL(document.currentScript.src).origin
      }
    } catch (_) {}
    return 'https://web3keys.com'
  })()
  var PREFIX = 'SmartLedger Wallet sign-in v1'
  var NONCE_KEY = 'sl-login-nonce'
  var SESSION_KEY_PREFIX = 'sl-session:'

  function randNonce () {
    var b = new Uint8Array(16)
    crypto.getRandomValues(b)
    var s = ''
    for (var i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0')
    return s
  }

  function buildPayload (domain, nonce) {
    return PREFIX + '\nDomain: ' + domain + '\nNonce: ' + nonce
  }

  function sessionKey (authority) { return SESSION_KEY_PREFIX + (authority || AUTHORITY) }
  function channelName (authority) { return 'sl-login:' + (authority || AUTHORITY) }

  // Lazily-created per-authority BroadcastChannel. Same-origin only — wallets
  // open on a different domain don't see these messages.
  var channels = {}
  function getChannel (authority) {
    if (typeof BroadcastChannel === 'undefined') return null
    var name = channelName(authority)
    if (!channels[name]) {
      try { channels[name] = new BroadcastChannel(name) } catch (_) { channels[name] = null }
    }
    return channels[name]
  }
  function broadcast (authority, event) {
    var ch = getChannel(authority)
    if (ch) try { ch.postMessage(event) } catch (_) {}
  }

  function storeSession (authority, token, address, exp) {
    try {
      localStorage.setItem(sessionKey(authority), JSON.stringify({ token: token, address: address, exp: exp }))
      broadcast(authority, { type: 'signedIn', address: address, exp: exp })
    } catch (_) {}
  }
  function loadSession (authority) {
    try {
      var raw = localStorage.getItem(sessionKey(authority))
      if (!raw) return null
      var s = JSON.parse(raw)
      if (!s || typeof s.exp !== 'number' || s.exp * 1000 < Date.now()) {
        localStorage.removeItem(sessionKey(authority))
        return null
      }
      return s
    } catch (_) { return null }
  }
  function dropSession (authority, broadcastSignOut) {
    try { localStorage.removeItem(sessionKey(authority)) } catch (_) {}
    if (broadcastSignOut !== false) broadcast(authority, { type: 'signedOut' })
  }

  // Begin a sign-in. Redirects the user to the wallet, where they'll see an
  // approval card and (on approve) be redirected back to redirectUri with
  // ?address=&signature=&challenge=  (or ?error=user_cancelled).
  //
  // opts.app          Friendly name to show in the wallet's approval card.
  // opts.redirectUri  Defaults to current location.origin + pathname.
  // opts.authority    Override wallet base URL (defaults to SmartLedger).
  // opts.request      Optional array of additional scopes the app would like
  //                   the user to share alongside the identity signature.
  //                   Supported: 'ordinals' (1Sat receive address),
  //                   'finance' (BSV payment receive address). The wallet
  //                   shows the user a checkbox per requested scope; the
  //                   user can uncheck. Granted scopes come back as
  //                   ?ordAddress=… / ?finAddress=… on the callback URL.
  //                   No private key material ever leaves the wallet.
  function start (opts) {
    opts = opts || {}
    var app = opts.app || 'A web app'
    var redirectUri = opts.redirectUri || (location.origin + location.pathname)
    var authority = (opts.authority || AUTHORITY).replace(/\/$/, '')
    var nonce = randNonce()
    try { sessionStorage.setItem(NONCE_KEY, nonce) } catch (_) {}
    var url = authority + '/login' +
      '?challenge=' + encodeURIComponent(nonce) +
      '&redirect_uri=' + encodeURIComponent(redirectUri) +
      '&app=' + encodeURIComponent(app)
    if (Array.isArray(opts.request) && opts.request.length > 0) {
      // Normalize: only known scope names pass through, comma-separated.
      var known = { ordinals: 1, finance: 1 }
      var scopes = opts.request.filter(function (s) { return known[s] }).join(',')
      if (scopes) url += '&request=' + encodeURIComponent(scopes)
    }
    location.href = url
  }

  // Inspect the current URL for a sign-in callback. Returns a Promise that
  // resolves to one of:
  //   { status: 'no_callback' }                              no relevant query params
  //   { status: 'cancelled' }                                user pressed Cancel in wallet
  //   { status: 'ok', address, signature, challenge, payload }
  //   { status: 'unverified', ... }                          verify=false was passed
  //   { status: 'error', reason, ... }
  function checkCallback (opts) {
    opts = opts || {}
    var verify = opts.verify !== false
    var authority = (opts.authority || AUTHORITY).replace(/\/$/, '')
    var params = new URLSearchParams(location.search)
    if (params.get('error') === 'user_cancelled') {
      try { sessionStorage.removeItem(NONCE_KEY) } catch (_) {}
      return Promise.resolve({ status: 'cancelled' })
    }
    var address = params.get('address')
    var signature = params.get('signature')
    var challenge = params.get('challenge')
    if (!address || !signature || !challenge) {
      return Promise.resolve({ status: 'no_callback' })
    }
    // Optional consent-shared receive addresses. Present only if the
    // integrator requested them via opts.request AND the user kept the
    // checkbox checked on the approval card. Pure address strings —
    // never private-key material.
    var ordAddress = params.get('ordAddress') || null
    var finAddress = params.get('finAddress') || null
    var expected = null
    try { expected = sessionStorage.getItem(NONCE_KEY) } catch (_) {}
    try { sessionStorage.removeItem(NONCE_KEY) } catch (_) {}
    if (!expected || expected !== challenge) {
      return Promise.resolve({ status: 'error', reason: 'nonce_mismatch', address: address, signature: signature, challenge: challenge })
    }
    var domain = location.hostname
    var payload = buildPayload(domain, challenge)
    if (!verify) {
      return Promise.resolve({ status: 'unverified', address: address, signature: signature, challenge: challenge, payload: payload, ordAddress: ordAddress, finAddress: finAddress })
    }
    return fetch(authority + '/api/verify-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: address, signature: signature, challenge: challenge, domain: domain })
    }).then(function (res) {
      if (!res.ok) return { status: 'error', reason: 'server_' + res.status, address: address, signature: signature, challenge: challenge, payload: payload, ordAddress: ordAddress, finAddress: finAddress }
      return res.json().then(function (data) {
        if (data && data.valid) {
          if (data.token && data.exp) storeSession(authority, data.token, address, data.exp)
          return { status: 'ok', address: address, signature: signature, challenge: challenge, payload: payload, ordAddress: ordAddress, finAddress: finAddress, expiresAt: data.exp ? data.exp * 1000 : null }
        }
        return { status: 'error', reason: (data && data.reason) || 'invalid_signature', address: address, signature: signature, challenge: challenge, payload: payload, ordAddress: ordAddress, finAddress: finAddress }
      })
    }).catch(function (e) {
      return { status: 'error', reason: 'fetch_failed: ' + e.message, address: address, signature: signature, challenge: challenge, payload: payload, ordAddress: ordAddress, finAddress: finAddress }
    })
  }

  // Synchronous: returns the locally cached session if not yet expired.
  // Does NOT call the server. Use verifySession() if you want a fresh check.
  //
  //   { address: '1...', expiresAt: <ms epoch> }   or   null
  function session (opts) {
    opts = opts || {}
    var authority = (opts.authority || AUTHORITY).replace(/\/$/, '')
    var s = loadSession(authority)
    if (!s) return null
    return { address: s.address, expiresAt: s.exp * 1000 }
  }

  // Async: validates the locally stored token against the wallet's
  // /api/check-session endpoint. Returns the address on success, or null.
  // Will also clear the local session if the server reports it invalid.
  function verifySession (opts) {
    opts = opts || {}
    var authority = (opts.authority || AUTHORITY).replace(/\/$/, '')
    var s = loadSession(authority)
    if (!s) return Promise.resolve(null)
    return fetch(authority + '/api/check-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: s.token, domain: location.hostname })
    }).then(function (res) {
      if (!res.ok) return null
      return res.json().then(function (data) {
        if (data && data.valid) return { address: data.address, expiresAt: data.exp * 1000 }
        dropSession(authority)
        return null
      })
    }).catch(function () { return null })
  }

  // Clear the local session. By default also revokes the server-side token
  // so other tabs/devices/browsers using the same token can't continue.
  //
  //   SLLogin.signOut()                       // local + server revoke
  //   SLLogin.signOut({ everywhere: false })  // local only (fastest)
  function signOut (opts) {
    opts = opts || {}
    var authority = (opts.authority || AUTHORITY).replace(/\/$/, '')
    var everywhere = opts.everywhere !== false
    var s = loadSession(authority)
    dropSession(authority)
    if (!everywhere || !s) return Promise.resolve({ revoked: false })
    return fetch(authority + '/api/revoke-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: s.token, domain: location.hostname })
    }).then(function (res) { return res.ok ? res.json() : { revoked: false } })
      .catch(function () { return { revoked: false } })
  }

  // Subscribe to sign-in / sign-out events from other tabs on the same origin.
  // The callback receives the event object: { type: 'signedIn', address, exp }
  // or { type: 'signedOut' }. Returns an unsubscribe function.
  function onChange (cb, opts) {
    opts = opts || {}
    var authority = (opts.authority || AUTHORITY).replace(/\/$/, '')
    var ch = getChannel(authority)
    if (!ch) return function () {}
    var handler = function (e) { try { cb(e.data) } catch (_) {} }
    ch.addEventListener('message', handler)
    return function () { ch.removeEventListener('message', handler) }
  }

  // Wipe any stored nonce. Call this on your own logout.
  function clear () {
    try { sessionStorage.removeItem(NONCE_KEY) } catch (_) {}
  }

  // Strip ?address=&signature=&challenge= from the URL bar without reloading.
  function cleanUrl () {
    try {
      var u = new URL(location.href)
      u.searchParams.delete('address')
      u.searchParams.delete('signature')
      u.searchParams.delete('challenge')
      u.searchParams.delete('error')
      history.replaceState(null, '', u.pathname + (u.search ? u.search : '') + u.hash)
    } catch (_) {}
  }

  global.SLLogin = {
    start: start,
    checkCallback: checkCallback,
    session: session,
    verifySession: verifySession,
    signOut: signOut,
    onChange: onChange,
    clear: clear,
    cleanUrl: cleanUrl,
    version: 2
  }

  // ====================================================================
  // SLAttest — structured-payload signing
  //
  //   <script src="https://wallet.smartledger.technology/sl-login.js"></script>
  //   <script>
  //     // Request the user to sign a payload string:
  //     SLAttest.start({
  //       app: 'My App',
  //       payload: JSON.stringify(envelope),         // canonical bytes
  //       redirectUri: 'https://my.app/work/done'    // defaults to current page
  //     })
  //
  //     // On the redirect_uri page:
  //     SLAttest.checkCallback().then(r => {
  //       if (r.status === 'ok') {
  //         // r.address, r.signature, r.payload, r.signedMessage
  //       }
  //     })
  //   </script>
  //
  // Verification happens server-side via /api/verify-attest by default.
  // Pass { verify: false } to checkCallback() to do your own crypto with
  // bsv.Message.verify(r.signedMessage, r.address, r.signature).

  var ATTEST_NONCE_KEY = 'sl-attest-nonce'

  function attestRandomNonce () { return randNonce() }

  function b64url (s) {
    // utf-8 string → base64url
    var b64 = btoa(unescape(encodeURIComponent(s)))
    return b64.replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_')
  }

  function buildAttestSignedMessage (app, domain, nonce, payload) {
    return 'SmartLedger Wallet attest v1' +
      '\nApp: ' + app +
      '\nDomain: ' + domain +
      '\nNonce: ' + nonce +
      '\nPayload: ' + payload
  }

  function attestStart (opts) {
    opts = opts || {}
    if (typeof opts.payload !== 'string' || opts.payload.length === 0) {
      throw new Error('SLAttest.start: payload must be a non-empty string')
    }
    if (opts.payload.length > 4096) {
      throw new Error('SLAttest.start: payload over 4 KB limit')
    }
    var app = opts.app || 'A web app'
    var redirectUri = opts.redirectUri || (location.origin + location.pathname)
    var authority = (opts.authority || AUTHORITY).replace(/\/$/, '')
    var nonce = attestRandomNonce()
    try { sessionStorage.setItem(ATTEST_NONCE_KEY, JSON.stringify({ nonce: nonce, payload: opts.payload })) } catch (_) {}
    location.href = authority + '/attest' +
      '?app=' + encodeURIComponent(app) +
      '&redirect_uri=' + encodeURIComponent(redirectUri) +
      '&nonce=' + encodeURIComponent(nonce) +
      '&payload=' + encodeURIComponent(b64url(opts.payload))
  }

  function attestCheckCallback (opts) {
    opts = opts || {}
    var verify = opts.verify !== false
    var authority = (opts.authority || AUTHORITY).replace(/\/$/, '')
    var params = new URLSearchParams(location.search)
    if (params.get('error') === 'user_cancelled') {
      try { sessionStorage.removeItem(ATTEST_NONCE_KEY) } catch (_) {}
      return Promise.resolve({ status: 'cancelled' })
    }
    var address = params.get('address')
    var signature = params.get('signature')
    var nonce = params.get('nonce')
    if (!address || !signature || !nonce) return Promise.resolve({ status: 'no_callback' })
    var stored = null
    try { stored = JSON.parse(sessionStorage.getItem(ATTEST_NONCE_KEY) || 'null') } catch (_) {}
    try { sessionStorage.removeItem(ATTEST_NONCE_KEY) } catch (_) {}
    if (!stored || stored.nonce !== nonce) {
      return Promise.resolve({ status: 'error', reason: 'nonce_mismatch', address: address, signature: signature, nonce: nonce })
    }
    var domain = location.hostname
    // Default app name match: caller may pass an app string for stricter binding.
    var app = opts.app || (params.get('app') || domain)
    var payload = stored.payload
    var signedMessage = buildAttestSignedMessage(app, domain, nonce, payload)
    if (!verify) {
      return Promise.resolve({ status: 'unverified', address: address, signature: signature, payload: payload, signedMessage: signedMessage, nonce: nonce })
    }
    return fetch(authority + '/api/verify-attest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: address, signature: signature, payload: payload, app: app, domain: domain, nonce: nonce })
    }).then(function (res) {
      if (!res.ok) return { status: 'error', reason: 'server_' + res.status, address: address, signature: signature, payload: payload, signedMessage: signedMessage, nonce: nonce }
      return res.json().then(function (data) {
        if (data && data.valid) return { status: 'ok', address: address, signature: signature, payload: payload, signedMessage: data.signedMessage || signedMessage, nonce: nonce }
        return { status: 'error', reason: (data && data.reason) || 'invalid_signature', address: address, signature: signature, payload: payload, signedMessage: signedMessage, nonce: nonce }
      })
    }).catch(function (e) {
      return { status: 'error', reason: 'fetch_failed: ' + e.message, address: address, signature: signature, payload: payload, signedMessage: signedMessage, nonce: nonce }
    })
  }

  function attestCleanUrl () {
    try {
      var u = new URL(location.href)
      u.searchParams.delete('address')
      u.searchParams.delete('signature')
      u.searchParams.delete('nonce')
      u.searchParams.delete('error')
      history.replaceState(null, '', u.pathname + (u.search ? u.search : '') + u.hash)
    } catch (_) {}
  }

  global.SLAttest = {
    start: attestStart,
    checkCallback: attestCheckCallback,
    cleanUrl: attestCleanUrl,
    version: 1
  }

  // ====================================================================
  // SLPublish — self-funded OP_RETURN broadcast
  //
  //   SLPublish.start({
  //     app: 'My App',
  //     outputs: [{ fields: ['<hex1>', '<hex2>', ...] }, ...],   // 1-4 outputs, each 1-20 pushes
  //     redirectUri: 'https://my.app/published'                  // optional
  //   })
  //
  //   SLPublish.checkCallback().then(r => {
  //     if (r.status === 'ok') { /* r.txid */ }
  //   })
  //
  // The wallet shows the user every push (rendered ASCII or hex), the
  // funding address, the estimated fee, then broadcasts on Approve. The user
  // spends their OWN BSV — for free publish use /api/sponsored-publish from
  // your backend (see docs §SLPublish vs sponsored).

  var PUBLISH_NONCE_KEY = 'sl-publish-nonce'
  function publishStart (opts) {
    opts = opts || {}
    if (!Array.isArray(opts.outputs) || opts.outputs.length === 0 || opts.outputs.length > 4) {
      throw new Error('SLPublish.start: outputs must be a 1-4 element array')
    }
    for (var i = 0; i < opts.outputs.length; i++) {
      var o = opts.outputs[i]
      if (!o || !Array.isArray(o.fields) || o.fields.length === 0 || o.fields.length > 20) {
        throw new Error('SLPublish.start: each output must have a 1-20 element fields array')
      }
      for (var j = 0; j < o.fields.length; j++) {
        if (typeof o.fields[j] !== 'string' || !/^[0-9a-f]*$/i.test(o.fields[j])) {
          throw new Error('SLPublish.start: every field must be a hex string')
        }
      }
    }
    var app = opts.app || 'A web app'
    var redirectUri = opts.redirectUri || (location.origin + location.pathname)
    var authority = (opts.authority || AUTHORITY).replace(/\/$/, '')
    var nonce = randNonce()
    var payload = JSON.stringify({ outputs: opts.outputs })
    if (payload.length > 8000) {
      throw new Error('SLPublish.start: total field hex too large for URL (~8 KB cap)')
    }
    try { sessionStorage.setItem(PUBLISH_NONCE_KEY, nonce) } catch (_) {}
    location.href = authority + '/publish' +
      '?app=' + encodeURIComponent(app) +
      '&redirect_uri=' + encodeURIComponent(redirectUri) +
      '&nonce=' + encodeURIComponent(nonce) +
      '&outputs=' + encodeURIComponent(b64url(payload))
  }

  function publishCheckCallback () {
    var params = new URLSearchParams(location.search)
    var nonce = params.get('nonce')
    var stored = null
    try { stored = sessionStorage.getItem(PUBLISH_NONCE_KEY) } catch (_) {}
    if (params.get('error') === 'user_cancelled') {
      try { sessionStorage.removeItem(PUBLISH_NONCE_KEY) } catch (_) {}
      return Promise.resolve({ status: 'cancelled' })
    }
    var txid = params.get('txid')
    if (!txid || !nonce) return Promise.resolve({ status: 'no_callback' })
    try { sessionStorage.removeItem(PUBLISH_NONCE_KEY) } catch (_) {}
    if (!stored || stored !== nonce) {
      return Promise.resolve({ status: 'error', reason: 'nonce_mismatch', txid: txid, nonce: nonce })
    }
    return Promise.resolve({ status: 'ok', txid: txid, nonce: nonce })
  }

  function publishCleanUrl () {
    try {
      var u = new URL(location.href)
      u.searchParams.delete('txid')
      u.searchParams.delete('nonce')
      u.searchParams.delete('error')
      history.replaceState(null, '', u.pathname + (u.search ? u.search : '') + u.hash)
    } catch (_) {}
  }

  global.SLPublish = {
    start: publishStart,
    checkCallback: publishCheckCallback,
    cleanUrl: publishCleanUrl,
    version: 1
  }

  // ====================================================================
  // SLProfile — BAP profile resolution
  //
  //   await SLProfile.resolve('2aWfpccxfqLpUwLjSXxnmbDM9Bs6')
  //   await SLProfile.resolve('1419gbTgdpU9g5LTN1FVGjsM5Wuw6jburL')  // address shortcut
  //   await SLProfile.resolveBapId(bapId, { indexer: 'https://my-indexer' })
  //
  // The address shortcut works only when window.bsv is loaded (the wallet
  // shell loads it automatically; third-party pages may not). For
  // BAP-ID-only callers, use SLProfile.resolveBapId directly.

  var DEFAULT_INDEXER = 'https://bap.network'

  function profileBapIdFromAddress (address) {
    if (typeof address !== 'string' || address.length < 26) return null
    if (typeof bsv === 'undefined' || !bsv.crypto || !bsv.encoding) return null
    var h1 = bsv.crypto.Hash.sha256(Buffer.from(address))
    var h2 = bsv.crypto.Hash.ripemd160(h1)
    return bsv.encoding.Base58(h2).toString()
  }

  function profileShape (data) {
    if (!data || typeof data !== 'object') return null
    // bap.network returns a wrapper; normalize to a stable shape.
    var inner = data.result || data.id || data.identity || data
    var attrs = inner && (inner.identity || inner.attributes || inner)
    return {
      bapId: inner.idKey || inner.bapId || inner.id || null,
      address: inner.currentAddress || null,
      identityKey: inner.idKey || inner.identityKey || null,
      currentAddress: inner.currentAddress || null,
      name: attrs && (attrs.name || attrs.alternateName) || null,
      image: attrs && (attrs.image || attrs.avatar) || null,
      description: attrs && (attrs.description || attrs.bio) || null,
      pubkey: attrs && attrs.pubkey || null
    }
  }

  function profileResolveBapId (bapId, opts) {
    opts = opts || {}
    var indexer = (opts.indexer || DEFAULT_INDEXER).replace(/\/$/, '')
    if (typeof bapId !== 'string' || bapId.length < 20 || bapId.length > 64) {
      return Promise.resolve(null)
    }
    return fetch(indexer + '/api/v1/id/' + encodeURIComponent(bapId))
      .then(function (res) {
        if (res.status === 404) return null
        if (!res.ok) return null
        return res.json().then(profileShape)
      })
      .catch(function () { return null })
  }

  function profileResolve (addressOrBapId, opts) {
    if (typeof addressOrBapId !== 'string' || addressOrBapId.length === 0) {
      return Promise.resolve(null)
    }
    // Heuristic: BAP IDs are typically 28 chars base58 from a 20-byte hash;
    // base58check addresses start with 1 and are 26–35 chars. Try the
    // address-shortcut path first when bsv is available, else assume BAP ID.
    if (/^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(addressOrBapId) && typeof bsv !== 'undefined') {
      var bapId = profileBapIdFromAddress(addressOrBapId)
      if (!bapId) return Promise.resolve(null)
      return profileResolveBapId(bapId, opts)
    }
    return profileResolveBapId(addressOrBapId, opts)
  }

  global.SLProfile = {
    bapIdFromAddress: profileBapIdFromAddress,
    resolve: profileResolve,
    resolveBapId: profileResolveBapId,
    version: 1
  }
})(typeof window !== 'undefined' ? window : globalThis)
