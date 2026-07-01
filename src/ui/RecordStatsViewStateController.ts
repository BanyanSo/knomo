import {
	canAdvanceRecordStatsDate,
	canRetreatRecordStatsDate,
	shiftRecordStatsDate,
	type RecordStatsView,
} from "../services/RecordStatsService";

interface RecordStatsViewStateSnapshot {
	view: RecordStatsView;
	selectedDate: Date;
}

export class RecordStatsViewStateController {
	private view: RecordStatsView = "week";
	private selectedDate: Date;
	private renderedKey: string | null = null;

	constructor(initialDate = new Date()) {
		this.selectedDate = new Date(initialDate.getTime());
	}

	getSnapshot(): RecordStatsViewStateSnapshot {
		return {
			view: this.view,
			selectedDate: new Date(this.selectedDate.getTime()),
		};
	}

	isRendered(renderKey: string): boolean {
		return this.renderedKey === renderKey;
	}

	markRendered(renderKey: string): void {
		this.renderedKey = renderKey;
	}

	clearRendered(): void {
		this.renderedKey = null;
	}

	canAdvance(): boolean {
		return canAdvanceRecordStatsDate(this.view, this.selectedDate);
	}

	canRetreat(earliestYear: number | null): boolean {
		return canRetreatRecordStatsDate(this.view, this.selectedDate, earliestYear);
	}

	goToPrevious(earliestYear: number | null): boolean {
		if (!this.canRetreat(earliestYear)) {
			return false;
		}
		this.selectedDate = shiftRecordStatsDate(this.view, this.selectedDate, -1);
		return true;
	}

	goToNext(): boolean {
		if (!this.canAdvance()) {
			return false;
		}
		this.selectedDate = shiftRecordStatsDate(this.view, this.selectedDate, 1);
		return true;
	}

	setView(view: RecordStatsView): boolean {
		if (this.view === view) {
			return false;
		}
		this.view = view;
		return true;
	}
}
