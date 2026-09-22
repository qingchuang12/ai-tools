/**
 * renderer build flag 入口：`__BUILD_FLAGS__` 由 vite.config.mts 的 `define` 编译期内联
 * （产物中不存在该标识符，terser/混淆链安全）；vitest 等无 define 环境不得直接 import 本文件。
 */

import type {BuildFlags, BuildFlagsInput} from '../../shared/build-flags';
import {resolveBuildFlags} from '../../shared/build-flags';

declare const __BUILD_FLAGS__: BuildFlagsInput;

export const BUILD_FLAGS: BuildFlags = resolveBuildFlags(__BUILD_FLAGS__);
