const { getDefaultConfig } = require('expo/metro-config')
const path = require('path')

const monorepoRoot = path.resolve(__dirname, '..', '..')
const cero = path.resolve(monorepoRoot, 'packages/cero/src')

const config = getDefaultConfig(__dirname)
config.projectRoot = __dirname
config.watchFolders = [monorepoRoot]
config.resolver.nodeModulesPaths = [
  path.resolve(__dirname, 'node_modules'),
  path.resolve(monorepoRoot, 'node_modules')
]

const subpaths = {
  cero: path.resolve(cero, 'index.js'),
  'chat-backend': path.resolve(monorepoRoot, 'example/chat-backend/index.js'),
  'chat-backend/schema': path.resolve(monorepoRoot, 'example/chat-backend/schema.js'),
  'chat-backend/spec': path.resolve(monorepoRoot, 'example/chat-backend/spec/index.js')
}

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (subpaths[moduleName]) return { type: 'sourceFile', filePath: subpaths[moduleName] }
  return context.resolveRequest(context, moduleName, platform)
}

module.exports = config
