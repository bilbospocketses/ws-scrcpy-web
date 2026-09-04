import type webpack from 'webpack';
import { backend, embedEntryConfig, frontend, libraryEsmConfig, libraryUmdConfig } from './ws-scrcpy-web.common';

const prodOpts: webpack.Configuration = {
    mode: 'production',
};

const front = () => Object.assign({}, frontend(), prodOpts);
const back = () => Object.assign({}, backend(), prodOpts);
const libUmd = () => Object.assign({}, libraryUmdConfig(), prodOpts);
const libEsm = () => Object.assign({}, libraryEsmConfig(), prodOpts);
const embed = () => Object.assign({}, embedEntryConfig(), prodOpts);

module.exports = [front, back, libUmd, libEsm, embed];
