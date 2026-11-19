import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after } from 'node:test'
import { createBlobStorage } from '@nuxthub/core/blob'
import { createDriver } from '@nuxthub/core/blob/drivers/fs'
import { registerBlobProvider } from '../../server/utils/blob'

// Exercise the existing storage registry and driver contract without cloud credentials.
const directory = mkdtempSync(join(tmpdir(), 'feedlog-web-source-objects-'))
export const webSourceTestStorage = createBlobStorage(createDriver({ dir: directory }))
Reflect.set(globalThis, 'useRuntimeConfig', () => ({ blobProvider: 'web-source-test' }))
registerBlobProvider({ name: 'web-source-test', storage: webSourceTestStorage })
after(() => rm(directory, { recursive: true, force: true }))
