import type {AdProvider} from './types';

/**
 * 海外渠道：Overwolf Ads（`<owadview/>` 标签）。
 *
 * 核实结论（2026-09-21，overwolf.github.io/tools/ow-electron + npm registry）：
 * - owadview 是 ow-electron 底座内置标签（基于 webview 的广告容器，自动拉取/刷新/静音），
 *   无需属性；要求放在标准 IAB 尺寸容器内。
 * - ow-electron 官方支持与普通 electron 并存（加脚本变体，不强制换底座）；npm 包
 *   @overwolf/ow-electron 最新为 42.7.1（无 43 线，项目锁定 electron 43.0.0——换底座需降基线，
 *   属独立验证项）。
 * - 广告开通前置：Overwolf Console 注册 App UID + 联系 Overwolf 配置开通；打包须用
 *   @overwolf/ow-electron-builder；发布需 Overwolf 签名 + 开发者 DSC 双签。
 *   未开通时 owadview 不出广告，不影响本组件。
 * - 底座切换前置：主进程 BrowserWindow 需开 webPreferences.webviewTag: true（仅海外版）。
 *
 * 普通 Electron 下 owadview 是未知元素——无渲染、无副作用，因此无需底座探测即可安全挂载。
 */
export class OverwolfAdProvider implements AdProvider {
    readonly name = 'overwolf';
    private view: HTMLElement | null = null;

    init(container: HTMLElement): Promise<boolean> {
        if (typeof document === 'undefined') return Promise.resolve(false);
        const view = document.createElement('owadview');
        view.style.width = '100%';
        view.style.height = '100%';
        view.style.display = 'block';
        container.appendChild(view);
        this.view = view;
        return Promise.resolve(true);
    }

    destroy(): void {
        this.view?.remove();
        this.view = null;
    }
}
