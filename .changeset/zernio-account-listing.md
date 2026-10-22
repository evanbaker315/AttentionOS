---
"@attentionos/provider-publish-zernio": patch
"@attentionos/studio": patch
"@attentionos/core": patch
---

Zernio keys validate again. Listing accounts no longer sends `limit` without `page`, which Zernio now rejects, so `./aos doctor`, the setup Keys step, `listAccounts` and comment automations work with a valid key. Own-account sync before any accounts are synced reads every account the key can see instead of failing on `accountId=me`.
