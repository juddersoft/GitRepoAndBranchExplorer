import * as vscode from 'vscode';
import { buildGitHubCommitUrl } from '../git/gitService';

const GITHUB_PROVIDER_ID = 'github';
const GITHUB_SCOPES = ['repo'];

/**
 * Thin wrapper over VS Code's built-in GitHub authentication provider. Sessions are owned and stored
 * by VS Code's secret storage; this extension never writes tokens to disk or settings.
 */
export class GitHubService {
  public getSession(createIfNone: boolean): Thenable<vscode.AuthenticationSession | undefined> {
    return createIfNone
      ? vscode.authentication.getSession(GITHUB_PROVIDER_ID, GITHUB_SCOPES, { createIfNone: true })
      : vscode.authentication.getSession(GITHUB_PROVIDER_ID, GITHUB_SCOPES, { silent: true });
  }

  public async isSignedIn(): Promise<boolean> {
    return (await this.getSession(false)) !== undefined;
  }

  /** Prompts the user to sign in; returns the account label, or null if they cancelled. */
  public async signIn(): Promise<string | null> {
    try {
      const session = await this.getSession(true);
      return session?.account.label ?? null;
    } catch {
      // The user dismissed the sign-in flow.
      return null;
    }
  }

  /** Opens the commit page in the browser after validating it is a `https://github.com/` URL. */
  public async openCommit(githubRemoteUrl: string, hash: string): Promise<boolean> {
    const url = buildGitHubCommitUrl(githubRemoteUrl, hash);
    if (url === null) {
      return false;
    }
    return vscode.env.openExternal(vscode.Uri.parse(url, true));
  }
}
