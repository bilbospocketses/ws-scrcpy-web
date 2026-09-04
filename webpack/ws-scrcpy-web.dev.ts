import type webpack from 'webpack';
import { backend, embedEntryConfig, frontend, libraryEsmConfig, libraryUmdConfig } from './ws-scrcpy-web.common';

const devOpts: webpack.Configuration = {
    devtool: 'inline-source-map',
    mode: 'development',
};

const front = () => Object.assign({}, frontend(), devOpts);
const back = () => Object.assign({}, backend(), devOpts);
const libUmd = () => Object.assign({}, libraryUmdConfig(), devOpts);
const libEsm = () => Object.assign({}, libraryEsmConfig(), devOpts);
const embed = () => Object.assign({}, embedEntryConfig(), devOpts);

module.exports = [front, back, libUmd, libEsm, embed];
