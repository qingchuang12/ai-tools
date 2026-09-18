/**
 * 单测专用：运行时临时生成的 Ed25519 密钥对。
 *
 * **仓库内不保存任何私钥**——密钥对在每次测试进程启动时现生成，进程结束即消失。
 * 端到端冒烟（T05）用的是后端真实私钥签发的 token，与此处无关。
 */

import {generateKeyPairSync} from 'node:crypto';

export const TEST_KEY_PAIR = generateKeyPairSync('ed25519');
