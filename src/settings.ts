import { App, Notice, PluginSettingTab, Setting, type TextComponent } from "obsidian";
import type GithubPRStatusPlugin from "./main";
import { GithubFetchError, testConnection } from "./api";

export interface GithubPRStatusSettings {
	accessToken: string;
	pollIntervalSeconds: number;
}

export const DEFAULT_SETTINGS: GithubPRStatusSettings = {
	accessToken: "",
	pollIntervalSeconds: 60,
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

		containerEl.createEl("h3", { text: "GitHub connection" });
		containerEl.createEl("p", {
			text:
				"This plugin works with GitHub.com only. Create a classic personal access token " +
				"with the 'repo' scope (or 'public_repo' if you only reference public repos).",
			cls: "setting-item-description",
		});

		let tokenComponent: TextComponent | undefined;
		new Setting(containerEl)
			.setName("Personal access token")
			.setDesc(
				"Create one at https://github.com/settings/tokens. " +
				"Stored unencrypted in this vault's plugin data."
			)
			.addText((text) => {
				tokenComponent = text;
				text.inputEl.type = "password";
				text.inputEl.autocomplete = "off";
				text
					.setPlaceholder("paste personal access token")
					.setValue(this.plugin.settings.accessToken)
					.onChange(async (value) => {
						this.plugin.settings.accessToken = value.trim();
						await this.plugin.saveSettings();
					});
			})
			.addExtraButton((btn) => {
				btn
					.setIcon("eye")
					.setTooltip("Show token")
					.onClick(() => {
						if (!tokenComponent) return;
						const isHidden = tokenComponent.inputEl.type === "password";
						tokenComponent.inputEl.type = isHidden ? "text" : "password";
						btn.setIcon(isHidden ? "eye-off" : "eye");
						btn.setTooltip(isHidden ? "Hide token" : "Show token");
					});
			});

		new Setting(containerEl)
			.setName("Test connection")
			.setDesc("Verify your access token by querying the GitHub GraphQL viewer endpoint.")
			.addButton((btn) =>
				btn
					.setButtonText("Test")
					.onClick(async () => {
						btn.setDisabled(true);
						btn.setButtonText("Testing…");
						try {
							const me = await testConnection({
								accessToken: this.plugin.settings.accessToken,
							});
							new Notice(`✓ Connected as ${me.login}`);
						} catch (e) {
							const msg =
								e instanceof GithubFetchError
									? e.message
									: (e as Error).message;
							new Notice(`✗ Connection failed: ${msg}`, 8000);
						} finally {
							btn.setDisabled(false);
							btn.setButtonText("Test");
						}
					})
			);

		containerEl.createEl("h3", { text: "Polling" });

		new Setting(containerEl)
			.setName("Poll interval (seconds)")
			.setDesc(
				"How often to re-check status for open PRs. Minimum 60 seconds."
			)
			.addText((text) =>
				text
					.setPlaceholder("60")
					.setValue(String(this.plugin.settings.pollIntervalSeconds))
					.onChange(async (value) => {
						const num = parseInt(value, 10);
						if (!isNaN(num) && num >= 60) {
							this.plugin.settings.pollIntervalSeconds = num;
							await this.plugin.saveSettings();
							this.plugin.restartPolling();
						}
					})
			);
	}
}
