import { parse, type Expression, type SpreadElement } from 'acorn'
import { CrawlError, MAX_PAGE_BYTES } from './fetch'

type Value = null | undefined | string | number | boolean | Value[] | { [key: string]: Value }

// Decode the Nuxt data format, never execute JavaScript. Network, DOM access,
// member reads, arbitrary callbacks and statements are outside this grammar.
export function decodeWebsiteData(source: string): Value {
  if (Buffer.byteLength(source) > MAX_PAGE_BYTES) throw new CrawlError('page_data_too_large')
  try {
    const ast = parse(source, { ecmaVersion: 'latest' })
    if (ast.body.length !== 1 || ast.body[0]?.type !== 'ExpressionStatement') throw Error('envelope')
    const top = ast.body[0].expression
    let expression: Expression | SpreadElement | undefined
    if (top.type === 'AssignmentExpression' && top.operator === '=' && top.left.type === 'MemberExpression'
      && !top.left.computed && top.left.object.type === 'Identifier' && top.left.object.name === 'window'
      && top.left.property.type === 'Identifier' && top.left.property.name === '__NUXT__') expression = top.right
    if (top.type === 'CallExpression' && top.callee.type === 'Identifier' && top.callee.name === '__NUXT_JSONP__'
      && top.arguments.length === 2 && top.arguments[0]?.type === 'Literal' && typeof top.arguments[0].value === 'string') expression = top.arguments[1]
    if (!expression) throw Error('envelope')
    let operations = 0
    function decode(node: Expression | SpreadElement, env: Map<string, Value>, depth = 0): Value {
      if (++operations > 100000 || depth > 80) throw Error('limit')
      switch (node.type) {
        case 'Literal':
          if (node.regex || node.bigint || typeof node.value === 'bigint' || typeof node.value === 'object' && node.value !== null) throw Error('literal')
          return node.value as Value
        case 'Identifier':
          if (env.has(node.name)) return env.get(node.name)
          if (node.name === 'undefined') return undefined
          throw Error('identifier')
        case 'ArrayExpression': return node.elements.map(item => item ? decode(item, env, depth + 1) : null)
        case 'ObjectExpression': {
          const value: Record<string, Value> = Object.create(null)
          for (const property of node.properties) {
            if (property.type !== 'Property' || property.computed || property.method || property.kind !== 'init') throw Error('property')
            const key = property.key.type === 'Identifier' ? property.key.name : property.key.type === 'Literal' ? String(property.key.value) : ''
            if (!key || ['__proto__', 'prototype', 'constructor'].includes(key)) throw Error('key')
            value[key] = decode(property.value as Expression, env, depth + 1)
          }
          return value
        }
        case 'UnaryExpression': {
          const value = decode(node.argument, env, depth + 1)
          if (value !== null && typeof value === 'object') throw Error('unary')
          if (node.operator === '!') return !value
          if (node.operator === '-' && typeof value === 'number') return -value
          if (node.operator === '+' && typeof value === 'number') return value
          if (node.operator === 'void' && value === 0) return undefined
          throw Error('unary')
        }
        case 'CallExpression': {
          const fn = node.callee
          if (fn.type !== 'FunctionExpression' || fn.async || fn.generator || fn.body.body.length !== 1
            || fn.body.body[0]?.type !== 'ReturnStatement' || !fn.body.body[0].argument) throw Error('call')
          const scope = new Map(env)
          const args = node.arguments.map(arg => decode(arg, env, depth + 1))
          for (const [index, parameter] of fn.params.entries()) {
            if (parameter.type !== 'Identifier') throw Error('parameter')
            scope.set(parameter.name, args[index])
          }
          return decode(fn.body.body[0].argument, scope, depth + 1)
        }
        default: throw Error('unsupported')
      }
    }
    return decode(expression, new Map())
  } catch { throw new CrawlError('page_data_unsupported') }
}
