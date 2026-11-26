import { button, el } from './dom';
import type { CreateWorktreeDialogPayload, WorktreeCreateFormState } from './worktreeCreateModel';
import {
  createInitialWorktreeFormState,
  joinDisplayPath,
  setWorktreeExistingBranch,
  setWorktreeFormMode,
  setWorktreeOpenInNewWindow,
  updateWorktreeFolderName,
  updateWorktreeNewBranchName,
  updateWorktreeParentFolder,
  validateWorktreeCreateForm,
} from './worktreeCreateModel';

export interface SubmitCreateWorktreePayload {
  readonly branchName: string;
  readonly createBranch: boolean;
  readonly startPoint?: string;
  readonly parentFolderPath: string;
  readonly folderName: string;
  readonly openInNewWindow: boolean;
}

export class CreateWorktreeModal {
  private readonly backdrop: HTMLDivElement;
  private readonly form: HTMLFormElement;
  private readonly existingRadio: HTMLInputElement | null;
  private readonly newRadio: HTMLInputElement | null;
  private readonly existingSelect: HTMLSelectElement;
  private readonly newBranchInput: HTMLInputElement;
  private readonly folderInput: HTMLInputElement;
  private readonly parentInput: HTMLInputElement;
  private readonly destination: HTMLElement;
  private readonly destinationBadge: HTMLElement;
  private readonly destinationIcon: HTMLElement;
  private readonly error: HTMLElement;
  private readonly createButton: HTMLButtonElement;
  private state: WorktreeCreateFormState;
  private closed = false;
  private readonly previousFocus: HTMLElement | null;

  constructor(
    request: CreateWorktreeDialogPayload,
    private readonly onSubmit: (payload: SubmitCreateWorktreePayload) => void,
    private readonly onBrowseParentFolder: (currentParentPath: string) => void,
    private readonly parent: HTMLElement = document.body,
  ) {
    this.state = createInitialWorktreeFormState(request);
    this.previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.backdrop = el('div', { className: 'branch-modal-backdrop' });
    this.form = el('form', {
      className: 'branch-modal worktree-modal',
      attrs: {
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': 'create-worktree-title',
        'aria-describedby': 'create-worktree-subtitle',
      },
    });
    this.form.noValidate = true;

    const title = el('h2', {
      className: 'branch-modal-title',
      text: 'Create Worktree',
      attrs: { id: 'create-worktree-title' },
    });
    const subtitle = el('p', {
      className: 'branch-modal-subtitle',
      text: 'Check out a branch in a separate folder (shared Git history).',
      attrs: { id: 'create-worktree-subtitle', title: 'Check out a branch in a separate folder (shared Git history).' },
    });

    const branchLabel = el('span', { className: 'branch-modal-label', text: 'Branch' });
    const existingOptions = this.state.availableBranches.map((branch) =>
      el('option', { text: branch, attrs: { value: branch } }),
    );
    this.existingSelect = el(
      'select',
      {
        className: 'branch-modal-input',
        attrs: { 'aria-label': 'Existing branch', 'aria-describedby': 'create-worktree-error' },
      },
      existingOptions,
    );
    this.existingSelect.value = this.state.selectedExistingBranch;
    this.existingSelect.disabled = this.state.availableBranches.length === 0;
    const noBranchesHint = el('span', {
      className: 'worktree-modal-hint',
      text: this.state.availableBranches.length === 0
        ? 'No existing branches are available; every local branch is checked out in a worktree.'
        : '',
    });

    this.newBranchInput = el('input', {
      className: 'branch-modal-input',
      attrs: {
        id: 'create-worktree-new-branch',
        type: 'text',
        autocomplete: 'off',
        spellcheck: 'false',
        'aria-label': 'New branch name',
        'aria-describedby': 'create-worktree-error',
      },
    });
    this.newBranchInput.value = this.state.newBranchName;

    const startPoint = this.state.startPoint === undefined
      ? null
      : el('span', { className: 'worktree-modal-hint', text: `Based on: ${this.state.startPoint}` });
    const existingSection = el('div', { className: 'worktree-branch-mode-content' }, [
      this.existingSelect,
      noBranchesHint,
    ]);
    existingSection.dataset.mode = 'existing';
    const newSection = el(
      'div',
      { className: 'worktree-branch-mode-content' },
      startPoint === null ? [this.newBranchInput] : [this.newBranchInput, startPoint],
    );
    newSection.dataset.mode = 'new';

    if (this.state.branchLocked) {
      this.existingRadio = null;
      this.newRadio = null;
    } else {
      this.existingRadio = this.radio('Existing branch', 'existing', this.state.mode === 'existing');
      this.newRadio = this.radio('New branch', 'new', this.state.mode === 'new');
    }

    const branchControl = this.state.branchLocked
      ? this.state.mode === 'existing'
        ? el('div', { className: 'worktree-branch-summary', text: this.state.selectedExistingBranch })
        : newSection
      : el('div', { className: 'worktree-branch-picker' }, [
          existingSection,
          newSection,
        ]);
    const branchChildren: HTMLElement[] = [];
    branchChildren.push(branchLabel);
    if (!this.state.branchLocked) {
      branchChildren.push(el('div', { className: 'worktree-mode-toggle' }, [
        this.radioLabel(this.existingRadio!, 'Existing branch'),
        this.radioLabel(this.newRadio!, 'New branch'),
      ]));
    }
    branchChildren.push(branchControl);
    const branchSection = el('div', { className: 'branch-modal-field worktree-branch-field' }, branchChildren);

    const folderLabel = el('label', {
      className: 'branch-modal-label',
      text: 'Worktree Folder Name',
      attrs: { for: 'create-worktree-folder' },
    });
    this.folderInput = el('input', {
      className: 'branch-modal-input',
      attrs: {
        id: 'create-worktree-folder',
        type: 'text',
        autocomplete: 'off',
        spellcheck: 'false',
        'aria-describedby': 'create-worktree-error',
      },
    });
    this.folderInput.value = this.state.folderName;
    const folderSection = el('div', { className: 'branch-modal-field' }, [folderLabel, this.folderInput]);

    const parentLabel = el('label', {
      className: 'branch-modal-label',
      text: 'Parent Folder',
      attrs: { for: 'create-worktree-parent' },
    });
    this.parentInput = el('input', {
      className: 'branch-modal-input',
      attrs: {
        id: 'create-worktree-parent',
        type: 'text',
        autocomplete: 'off',
        spellcheck: 'false',
        'aria-describedby': 'create-worktree-error',
      },
    });
    this.parentInput.value = this.state.parentFolderPath;
    const browseButton = button({
      className: 'branch-modal-button branch-modal-button-secondary worktree-browse-button',
      label: 'Browse…',
      showLabel: true,
    });
    browseButton.addEventListener('click', () => this.onBrowseParentFolder(this.state.parentFolderPath));

    this.destination = el('output', {
      className: 'worktree-destination-preview',
      attrs: { id: 'create-worktree-destination', 'aria-live': 'polite' },
    });
    const destinationLabel = el('span', {
      className: 'worktree-destination-label',
      text: 'Destination preview:',
    });
    this.destinationIcon = el('span', { className: 'worktree-destination-icon' });
    this.destinationBadge = el('span', { className: 'worktree-destination-badge' });
    this.destination.append(destinationLabel, this.destinationIcon, this.destinationBadge);

    const openInput = el('input', { attrs: { id: 'create-worktree-open', type: 'checkbox' } });
    openInput.checked = this.state.openInNewWindow;
    const openLabel = el('label', {
      className: 'branch-modal-checkbox-label',
      text: 'Open worktree in a new VS Code window',
      attrs: { for: 'create-worktree-open' },
    });
    openInput.addEventListener('change', () => {
      this.state = setWorktreeOpenInNewWindow(this.state, openInput.checked);
    });

    this.error = el('p', {
      className: 'branch-modal-error worktree-validation-banner',
      attrs: { id: 'create-worktree-error', role: 'status', 'aria-live': 'polite' },
    });
    const cancelButton = button({
      className: 'branch-modal-button branch-modal-button-secondary',
      label: 'Cancel',
      showLabel: true,
    });
    this.createButton = button({
      className: 'branch-modal-button branch-modal-button-primary',
      label: 'Create Worktree',
      showLabel: true,
    });
    this.createButton.type = 'submit';
    const openRow = el('div', { className: 'branch-modal-checkbox-row worktree-open-row' }, [openInput, openLabel]);
    const footerActions = el('div', { className: 'worktree-footer-actions' }, [cancelButton, this.createButton]);
    const footer = el('div', { className: 'branch-modal-footer worktree-modal-footer' }, [openRow, footerActions]);
    const header = el('div', { className: 'branch-modal-header worktree-modal-header' }, [title, subtitle]);
    const body = el('div', { className: 'branch-modal-body worktree-modal-body' }, [
      branchSection,
      folderSection,
      el('div', { className: 'branch-modal-field worktree-parent-field' }, [
        parentLabel,
        el('div', { className: 'worktree-parent-row' }, [this.parentInput, browseButton]),
      ]),
      this.destination,
      this.error,
    ]);

    this.form.append(
      header,
      body,
      footer,
    );
    this.backdrop.append(this.form);

    this.existingRadio?.addEventListener('change', () => {
      if (this.existingRadio?.checked) {
        this.changeMode('existing', existingSection, newSection);
      }
    });
    this.newRadio?.addEventListener('change', () => {
      if (this.newRadio?.checked) {
        this.changeMode('new', existingSection, newSection);
      }
    });
    this.existingSelect.addEventListener('change', () => {
      this.state = setWorktreeExistingBranch(this.state, this.existingSelect.value);
      this.syncInputs();
    });
    this.newBranchInput.addEventListener('input', () => {
      this.state = updateWorktreeNewBranchName(this.state, this.newBranchInput.value);
      this.syncInputs();
    });
    this.folderInput.addEventListener('input', () => {
      this.state = updateWorktreeFolderName(this.state, this.folderInput.value);
      this.renderValidation();
    });
    this.parentInput.addEventListener('input', () => {
      this.state = updateWorktreeParentFolder(this.state, this.parentInput.value, []);
      this.syncInputs();
    });
    this.form.addEventListener('submit', (event) => {
      event.preventDefault();
      this.submit();
    });
    cancelButton.addEventListener('click', () => this.close());
    this.backdrop.addEventListener('click', (event) => {
      if (event.target === this.backdrop) {
        this.close();
      }
    });
    this.backdrop.addEventListener('keydown', (event) => this.handleKeydown(event));
    this.renderMode(existingSection, newSection);
    this.renderValidation();
  }

  public open(): void {
    if (this.closed) {
      return;
    }
    this.parent.append(this.backdrop);
    window.requestAnimationFrame(() => {
      if (this.closed) {
        return;
      }
      const first = this.firstFocusTarget();
      first?.focus();
      if (first instanceof HTMLInputElement) {
        first.select();
      }
    });
  }

  public updateParentFolder(parentFolderPath: string, existingChildNames: string[]): void {
    if (this.closed) {
      return;
    }
    this.state = updateWorktreeParentFolder(this.state, parentFolderPath, existingChildNames);
    this.syncInputs();
  }

  public close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.backdrop.remove();
    if (this.previousFocus?.isConnected) {
      this.previousFocus.focus();
    }
  }

  private radio(label: string, value: 'existing' | 'new', checked: boolean): HTMLInputElement {
    const input = el('input', {
      attrs: {
        type: 'radio',
        name: 'create-worktree-mode',
        value,
        'aria-label': label,
      },
    });
    input.checked = checked;
    return input;
  }

  private radioLabel(input: HTMLInputElement, text: string): HTMLLabelElement {
    return el('label', { className: 'worktree-mode-option' }, [input, el('span', { text })]);
  }

  private changeMode(
    mode: 'existing' | 'new',
    existingSection: HTMLElement,
    newSection: HTMLElement,
  ): void {
    this.state = setWorktreeFormMode(this.state, mode);
    this.renderMode(existingSection, newSection);
    this.syncInputs();
  }

  private renderMode(existingSection: HTMLElement, newSection: HTMLElement): void {
    existingSection.hidden = this.state.mode !== 'existing';
    newSection.hidden = this.state.mode !== 'new';
    if (this.existingRadio) {
      this.existingRadio.checked = this.state.mode === 'existing';
    }
    if (this.newRadio) {
      this.newRadio.checked = this.state.mode === 'new';
    }
  }

  private syncInputs(): void {
    this.existingSelect.value = this.state.selectedExistingBranch;
    if (this.newBranchInput.value !== this.state.newBranchName) {
      this.newBranchInput.value = this.state.newBranchName;
    }
    if (this.folderInput.value !== this.state.folderName) {
      this.folderInput.value = this.state.folderName;
    }
    if (this.parentInput.value !== this.state.parentFolderPath) {
      this.parentInput.value = this.state.parentFolderPath;
    }
    this.renderValidation();
  }

  private renderValidation(): void {
    const error = validateWorktreeCreateForm(this.state);
    this.error.textContent = error ?? '';
    this.error.hidden = error === null;
    this.createButton.disabled = error !== null;
    const branchInvalid = error !== null && (
      error.includes('branch') ||
      error.includes('Branch') ||
      error.includes('Git ref')
    );
    this.existingSelect.setAttribute('aria-invalid', String(branchInvalid && this.state.mode === 'existing'));
    this.newBranchInput.setAttribute('aria-invalid', String(branchInvalid && this.state.mode === 'new'));
    this.folderInput.setAttribute('aria-invalid', String(error?.includes('folder name') === true));
    this.parentInput.setAttribute('aria-invalid', String(error?.includes('parent folder') === true));
    const fullDestination = joinDisplayPath(this.state.parentFolderPath, this.state.folderName);
    this.destinationBadge.textContent = fullDestination;
    this.destinationBadge.title = fullDestination;
  }

  private submit(): void {
    if (validateWorktreeCreateForm(this.state) !== null) {
      return;
    }
    const branchName = this.state.mode === 'existing'
      ? this.state.selectedExistingBranch
      : this.state.newBranchName.trim();
    const payload: SubmitCreateWorktreePayload = {
      branchName,
      createBranch: this.state.mode === 'new',
      ...(this.state.mode === 'new' && this.state.startPoint !== undefined
        ? { startPoint: this.state.startPoint }
        : {}),
      parentFolderPath: this.state.parentFolderPath.trim(),
      folderName: this.state.folderName,
      openInNewWindow: this.state.openInNewWindow,
    };
    this.close();
    this.onSubmit(payload);
  }

  private focusableElements(): HTMLElement[] {
    return Array.from(
      this.form.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((element) => !element.hidden && element.getClientRects().length > 0);
  }

  private firstFocusTarget(): HTMLElement | undefined {
    if (this.state.branchLocked) {
      return this.state.mode === 'new' ? this.newBranchInput : this.folderInput;
    }
    if (this.state.mode === 'new') {
      return this.newBranchInput;
    }
    return this.existingSelect.disabled
      ? this.existingRadio ?? this.newBranchInput
      : this.existingSelect;
  }

  private handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.close();
      return;
    }
    if (event.key !== 'Tab') {
      return;
    }
    const focusable = this.focusableElements();
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
}
