import type {AdProvider} from './types';

/**
 * 国内渠道：360联盟（占位实现，等同 Noop）。
 *
 * 核实结论（2026-09-21）：union.360.cn 多次直连/代理均超时不可达；公开搜索仅见
 * 移动端（Android）广告 API 对接文档与广告主投放工具（点睛等），未见 PC 桌面软件
 * 广告 SDK 的公开文档——plan 预判的「桌面端支持未确认」成立。
 * 接入方式待商务对接获取 SDK/文档后按 AdProvider 接口补齐；在此之前恒不填充。
 */
export class Union360AdProvider implements AdProvider {
    readonly name = 'union360';

    init(): Promise<boolean> {
        return Promise.resolve(false);
    }

    destroy(): void {
        // 占位实现无资源
    }
}
