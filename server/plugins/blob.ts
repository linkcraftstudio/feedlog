// Default blob provider — wraps @nuxthub/blob. Other providers (S3, R2,
// custom OSS bindings) can register via `registerBlobProvider()` from a
// Nitro plugin and will win resolve priority over this built-in fallback.

import { blob as nuxthubBlob } from '@nuxthub/blob'
import { consola } from 'consola'

const logger = consola.withTag('blob')

export default defineNitroPlugin(() => {
  registerBlobProvider({
    name: 'nuxthub',
    storage: nuxthubBlob,
  })
  logger.info('Registered blob provider: nuxthub')
})
