import { z } from 'zod'

export const aiTrainingReference = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('collection'), id: z.uuid(), enabled: z.boolean() }),
  z.object({ scope: z.literal('source'), id: z.uuid(), enabled: z.boolean() }),
])
