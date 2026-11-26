import type {
  CreateBranchDialogRequest,
  CreateBranchFormState,
} from './branchCreateModel';
import {
  createInitialBranchFormState,
  setBranchFormCheckout,
  setBranchFormTrack,
  updateBranchFormName,
  validateCreateBranchForm,
} from './branchCreateModel';
import { button, el } from './dom';

export interface SubmitCreateBranchPayload {
  readonly branchName: string;
  readonly startPoint?: string;
  readonly checkout: boolean;
  readonly track: boolean;
}

export class CreateBranchModal {
  private readonly backdrop: HTMLDivElement;
  private readonly form: HTMLFormElement;
  private readonly input: HTMLInputElement;
  private readonly checkoutInput: HTMLInputElement;
  private readonly trackInput: HTMLInputElement;
  private readonly trackHint: HTMLElement;
  private readonly error: HTMLElement;
  private readonly createButton: HTMLButtonElement;
  private state: CreateBranchFormState;
  private closed = false;

  constructor(
    private readonly request: CreateBranchDialogRequest,
    private readonly onSubmit: (payload: SubmitCreateBranchPayload) => void,
    private readonly parent: HTMLElement = document.body,
  ) {
    this.state = createInitialBranchFormState(request);
    this.backdrop = el('div', { className: 'branch-modal-backdrop' });
    this.form = el('form', { className: 'branch-modal', attrs: {
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': 'create-branch-title',
      'aria-describedby': 'create-branch-subtitle',
    } });
    this.form.noValidate = true;

    const title = el('h2', { className: 'branch-modal-title', text: 'Create New Branch', attrs: { id: 'create-branch-title' } });
    const subtitle = el('p', {
      className: 'branch-modal-subtitle',
      text: `Base: ${request.startLabel}`,
      attrs: { id: 'create-branch-subtitle' },
    });
    const nameLabel = el('label', { className: 'branch-modal-label', text: 'Branch name', attrs: { for: 'create-branch-name' } });
    this.input = el('input', {
      className: 'branch-modal-input',
      attrs: {
        id: 'create-branch-name',
        type: 'text',
        autocomplete: 'off',
        spellcheck: 'false',
        'aria-describedby': 'create-branch-error',
      },
    });
    this.input.value = this.state.branchName;

    this.checkoutInput = this.checkbox('branch-modal-checkout', this.state.checkout);
    const checkoutLabel = this.checkboxLabel('Checkout branch', 'branch-modal-checkout');
    this.trackInput = this.checkbox('branch-modal-track', this.state.track);
    this.trackInput.disabled = !this.state.canTrack;
    const trackText = request.remoteTrackingRef === undefined
      ? 'Track remote branch'
      : `Track remote branch (${request.remoteTrackingRef})`;
    const trackLabel = this.checkboxLabel(trackText, 'branch-modal-track');
    this.trackHint = el('span', {
      className: 'branch-modal-hint',
      text: this.state.canTrack ? '' : 'Tracking is available only when creating from a remote branch.',
    });
    this.error = el('p', {
      className: 'branch-modal-error',
      attrs: { id: 'create-branch-error', 'aria-live': 'polite' },
    });

    const cancelButton = button({ className: 'branch-modal-button branch-modal-button-secondary', label: 'Cancel', showLabel: true });
    this.createButton = button({ className: 'branch-modal-button branch-modal-button-primary', label: 'Create Branch', showLabel: true });
    this.createButton.type = 'submit';
    const footer = el('div', { className: 'branch-modal-footer' }, [cancelButton, this.createButton]);
    const header = el('div', { className: 'branch-modal-header' }, [title, subtitle]);
    const body = el('div', { className: 'branch-modal-body' }, [
      el('div', { className: 'branch-modal-field' }, [nameLabel, this.input]),
      el('div', { className: 'branch-modal-options' }, [
        el('div', { className: 'branch-modal-checkbox-row' }, [this.checkoutInput, checkoutLabel]),
        el('div', { className: 'branch-modal-checkbox-row' }, [this.trackInput, trackLabel]),
        this.trackHint,
      ]),
      this.error,
    ]);

    this.form.append(
      header,
      body,
      footer,
    );
    this.backdrop.append(this.form);

    this.input.addEventListener('input', () => {
      this.state = updateBranchFormName(this.state, this.input.value);
      this.trackInput.checked = this.state.track;
      this.renderValidation();
    });
    this.checkoutInput.addEventListener('change', () => {
      this.state = setBranchFormCheckout(this.state, this.checkoutInput.checked);
    });
    this.trackInput.addEventListener('change', () => {
      this.state = setBranchFormTrack(this.state, this.trackInput.checked);
      this.trackInput.checked = this.state.track;
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
    this.backdrop.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        this.close();
      }
    });
    this.renderValidation();
  }

  public open(): void {
    if (this.closed) {
      return;
    }
    this.parent.append(this.backdrop);
    window.requestAnimationFrame(() => {
      if (!this.closed) {
        this.input.focus();
        this.input.select();
      }
    });
  }

  public close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.backdrop.remove();
  }

  private checkbox(id: string, checked: boolean): HTMLInputElement {
    const input = el('input', { attrs: { id, type: 'checkbox' } });
    input.checked = checked;
    return input;
  }

  private checkboxLabel(text: string, id: string): HTMLLabelElement {
    return el('label', { className: 'branch-modal-checkbox-label', text, attrs: { for: id } });
  }

  private renderValidation(): void {
    const error = validateCreateBranchForm(this.state, this.request.existingLocalBranches);
    this.error.textContent = error ?? '';
    this.input.setAttribute('aria-invalid', String(error !== null));
    this.createButton.disabled = error !== null;
  }

  private submit(): void {
    if (validateCreateBranchForm(this.state, this.request.existingLocalBranches) !== null) {
      return;
    }
    const payload: SubmitCreateBranchPayload = {
      branchName: this.state.branchName.trim(),
      ...(this.request.startPoint === undefined ? {} : { startPoint: this.request.startPoint }),
      checkout: this.state.checkout,
      track: this.state.canTrack ? this.state.track : false,
    };
    this.close();
    this.onSubmit(payload);
  }
}
