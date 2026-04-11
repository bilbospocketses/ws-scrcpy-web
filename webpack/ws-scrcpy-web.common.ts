import path from 'path';
import webpack from 'webpack';
import MiniCssExtractPlugin from 'mini-css-extract-plugin';

export const PROJECT_ROOT = path.resolve(__dirname, '..');
export const SERVER_DIST_PATH = path.join(PROJECT_ROOT, 'dist');
export const CLIENT_DIST_PATH = path.join(PROJECT_ROOT, 'dist/public');

const buildConfigDefinePlugin = new webpack.DefinePlugin({
    '__PATHNAME__': JSON.stringify('/'),
});

// Inline plugin: generates a minimal package.json in dist/
class GenerateDistPackageJsonPlugin {
    apply(compiler: webpack.Compiler) {
        compiler.hooks.compilation.tap('GenerateDistPackageJsonPlugin', (compilation) => {
            compilation.hooks.processAssets.tap(
                {
                    name: 'GenerateDistPackageJsonPlugin',
                    stage: webpack.Compilation.PROCESS_ASSETS_STAGE_ADDITIONAL,
                },
                () => {
                    const pkg = {
                        name: 'ws-scrcpy-web',
                        version: '1.0.0',
                        scripts: { start: 'node index.js' },
                        dependencies: {
                            'node-pty': '^0.10.1',
                            'ws': '^8.18.0',
                        },
                    };
                    const content = JSON.stringify(pkg, null, 2);
                    compilation.emitAsset(
                        'package.json',
                        new webpack.sources.RawSource(content),
                    );
                },
            );
        });
    }
}

// Inline plugin: copies public/index.html into dist/public/
class CopyIndexHtmlPlugin {
    constructor(private src: string, private dest: string) {}
    apply(compiler: webpack.Compiler) {
        compiler.hooks.afterEmit.tapAsync('CopyIndexHtmlPlugin', (_: webpack.Compilation, callback: () => void) => {
            const fs = require('fs') as typeof import('fs');
            const destDir = path.dirname(this.dest);
            fs.mkdirSync(destDir, { recursive: true });
            fs.copyFileSync(this.src, this.dest);
            callback();
        });
    }
}

export const common = () => {
    return {
        module: {
            rules: [
                {
                    test: /\.css$/i,
                    use: [MiniCssExtractPlugin.loader, 'css-loader'],
                },
                {
                    test: /\.tsx?$/,
                    use: [{ loader: 'ts-loader', options: { transpileOnly: true } }],
                    exclude: /node_modules/,
                },
                {
                    test: /\.svg$/,
                    type: 'asset/source',
                },
                {
                    test: /\.(png|jpe?g|gif)$/i,
                    type: 'asset/resource',
                },
                {
                    test: /[\\/]assets[\\/]scrcpy-server/,
                    type: 'asset/resource',
                    generator: {
                        filename: 'assets/scrcpy-server',
                    },
                },
            ],
        },
        resolve: {
            extensions: ['.tsx', '.ts', '.js'],
        },
    };
};

const front: webpack.Configuration = {
    entry: path.join(PROJECT_ROOT, './src/app/index.ts'),
    externals: ['fs'],
    plugins: [
        new MiniCssExtractPlugin({ filename: 'bundle.css' }),
        new webpack.ProvidePlugin({
            Buffer: ['buffer', 'Buffer'],
        }),
        new CopyIndexHtmlPlugin(
            path.resolve(PROJECT_ROOT, 'public/index.html'),
            path.resolve(CLIENT_DIST_PATH, 'index.html'),
        ),
    ],
    resolve: {
        fallback: {
            path: 'path-browserify',
        },
        extensions: ['.tsx', '.ts', '.js'],
    },
    output: {
        filename: 'bundle.js',
        path: CLIENT_DIST_PATH,
    },
};

export const frontend = () => {
    return Object.assign({}, common(), front);
};

const back: webpack.Configuration = {
    entry: path.join(PROJECT_ROOT, './src/server/index.ts'),
    externals: [/^[a-z@]/],
    plugins: [
        new GenerateDistPackageJsonPlugin(),
        buildConfigDefinePlugin,
    ],
    node: {
        global: false,
        __filename: false,
        __dirname: false,
    },
    output: {
        filename: 'index.js',
        path: SERVER_DIST_PATH,
    },
    target: 'node',
};

export const backend = () => {
    return Object.assign({}, common(), back);
};
