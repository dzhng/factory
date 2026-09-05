declare const __FACTORY_VERSION__: string | undefined
declare const __FACTORY_REVISION__: string | undefined
declare const __FACTORY_TARGET__: string | undefined

export type FactoryBuildIdentity = {
  version: string
  revision: string
  target: string
  runtime: string
}

export const factoryBuildIdentity: FactoryBuildIdentity = {
  version: typeof __FACTORY_VERSION__ === 'string' ? __FACTORY_VERSION__ : '0.0.0-dev',
  revision: typeof __FACTORY_REVISION__ === 'string' ? __FACTORY_REVISION__ : 'development',
  target:
    typeof __FACTORY_TARGET__ === 'string'
      ? __FACTORY_TARGET__
      : `${process.platform}-${process.arch}`,
  runtime: `bun-${Bun.version}`,
}
