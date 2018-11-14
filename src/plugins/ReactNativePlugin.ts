import * as fs from 'fs';
import * as path from 'path';

import { Builder } from '../Builder';
import { ConfigPlugin } from '../ConfigPlugin';
import Spin from '../Spin';
import JSRuleFinder from './shared/JSRuleFinder';
import UPFinder from './shared/UPFinder';

let babelRegisterDone = false;

const registerBabel = (builder: Builder): void => {
  if (!babelRegisterDone) {
    const isBabel7 = builder.require.probe('@babel/core') && builder.require.probe('@babel/preset-flow');
    const babelRegister = isBabel7 ? '@babel/register' : 'babel-register';
    const reactNativePreset =
      isBabel7 && builder.require.probe('metro-react-native-babel-preset')
        ? 'metro-react-native-babel-preset'
        : 'babel-preset-react-native';
    // tslint:disable-next-line
    builder.require(babelRegister)({
      presets: [
        builder.require.resolve(reactNativePreset),
        builder.require.resolve(isBabel7 ? '@babel/preset-flow' : 'babel-preset-flow')
      ],
      ignore: [/node_modules\/(?!haul|react-native)/],
      retainLines: true,
      sourceMaps: 'inline'
    });
    // tslint:disable-next-line
    builder.require('babel-polyfill');

    babelRegisterDone = true;
  }
};

export default class ReactNativePlugin implements ConfigPlugin {
  public configure(builder: Builder, spin: Spin) {
    const stack = builder.stack;

    if (stack.hasAll(['react-native', 'webpack'])) {
      registerBabel(builder);

      const webpack = builder.require('webpack');

      const mobileAssetTest = /\.(bmp|gif|jpg|jpeg|png|psd|svg|webp|m4v|aac|aiff|caf|m4a|mp3|wav|html|pdf|ttf|otf)$/;

      const AssetResolver = builder.require('haul/src/resolvers/AssetResolver');
      const HasteResolver = builder.require('haul/src/resolvers/HasteResolver');

      const babelrc = new UPFinder(builder).find(['.babelrc.native', 'babel.config.js']);

      const jsRuleFinder = new JSRuleFinder(builder);
      const jsRule = jsRuleFinder.findAndCreateJSRule();
      const cacheDirectory =
        builder.cache === false || (builder.cache === 'auto' && !spin.dev)
          ? false
          : path.join(
              builder.cache === true || (builder.cache === 'auto' && spin.dev) ? '.cache' : builder.cache,
              'babel-loader'
            );
      const defaultConfig =
        babelrc && babelrc.endsWith('.babelrc.native')
          ? JSON.parse(fs.readFileSync(babelrc).toString())
          : {
              compact: !spin.dev,
              presets: (['expo'] as any[]).concat(spin.dev ? [] : [['minify', { mangle: false }]]),
              plugins: ['haul/src/utils/fixRequireIssues']
            };
      builder.config.module.rules.push({
        test: new RegExp(
          '^.*[\\\\\\/]node_modules[\\\\\\/].*\\.' +
            String(jsRule.test)
              .split('.')
              .pop()
              .slice(0, -1)
        ),
        exclude: /node_modules[\\\/](?!react-native.*|@module|@expo|expo|lottie-react-native|haul|pretty-format|react-navigation|antd-mobile-rn)$/,
        use: {
          loader: builder.require.probe('heroku-babel-loader') ? 'heroku-babel-loader' : 'babel-loader',
          options: spin.createConfig(
            builder,
            'babel',
            babelrc && babelrc.endsWith('.babelrc.native')
              ? {
                  babelrc: false,
                  cacheDirectory,
                  ...defaultConfig
                }
              : { babelrc: true, cacheDirectory }
          )
        }
      });

      builder.config.resolve.extensions = [`.${stack.platform}.`, '.native.', '.']
        .map(prefix => jsRuleFinder.extensions.map(ext => prefix + ext))
        .reduce((acc, val) => acc.concat(val))
        .concat(['.json']);

      const reactVer = builder.require('react-native/package.json').version.split('.')[1] >= 43 ? 16 : 15;
      const polyfillCode = fs
        .readFileSync(require.resolve(`../../react-native-polyfills/react-native-polyfill-${reactVer}`))
        .toString();
      const VirtualModules = builder.require('webpack-virtual-modules');
      builder.config = spin.merge(builder.config, {
        module: {
          rules: [
            { parser: { requireEnsure: false } },
            {
              test: mobileAssetTest,
              use: {
                loader: 'spinjs/lib/plugins/react-native/assetLoader',
                options: spin.createConfig(builder, 'asset', {
                  platform: stack.platform,
                  root: builder.require.cwd,
                  cwd: builder.require.cwd,
                  bundle: false
                })
              }
            }
          ]
        },
        resolve: {
          plugins: [
            new HasteResolver({
              directories: [path.join(path.dirname(builder.require.resolve('react-native/package.json')), 'Libraries')]
            }),
            new AssetResolver({
              platform: stack.platform,
              test: mobileAssetTest
            })
          ],
          mainFields: ['react-native', 'browser', 'main']
        },
        plugins: [new VirtualModules({ 'node_modules/@virtual/react-native-polyfill.js': polyfillCode })],
        target: 'webworker'
      });

      if (stack.hasAny('dll')) {
        builder.config = spin.merge(builder.config, {
          entry: {
            vendor: ['@virtual/react-native-polyfill']
          }
        });
      } else {
        const idx = builder.config.entry.index.indexOf('babel-polyfill');
        if (idx >= 0) {
          builder.config.entry.index.splice(idx, 1);
        }
        builder.config = spin.merge(
          {
            plugins: builder.sourceMap
              ? [
                  new webpack.SourceMapDevToolPlugin({
                    test: new RegExp(`\\.bundle$`),
                    filename: '[file].map'
                  })
                ]
              : [],
            entry: {
              index: ['@virtual/react-native-polyfill']
            }
          },
          builder.config
        );
      }
    }
  }
}
