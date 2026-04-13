import { App, PluginSettingTab, Setting } from "obsidian";
import type GithubPRStatusPlugin from "./main";

export interface GithubPRStatusSettings {
	pollIntervalSeconds: number;
}

export const DEFAULT_SETTINGS: GithubPRStatusSettings = {
	pollIntervalSeconds: 30,
};

export class GithubPRStatusSettingTab extends PluginSettingTab {
	plugin: GithubPRStatusPlugin;

	constructor(app: App, plugin: GithubPRStatusPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Poll interval (seconds)")
			.setDesc(
				"How often to re-check status for open PRs. Minimum 10 seconds."
			)
			.addText((text) =>
				text
					.setPlaceholder("30")
					.setValue(String(this.plugin.settings.pollIntervalSeconds))
					.onChange(async (value) => {
						const num = parseInt(value, 10);
						if (!isNaN(num) && num >= 10) {
							this.plugin.settings.pollIntervalSeconds = num;
							await this.plugin.saveSettings();
							this.plugin.restartPolling();
						}
					})
			);
	}
}
