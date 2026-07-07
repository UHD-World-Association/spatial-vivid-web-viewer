export class InfoPanel {

    constructor(container, captureScreenshot, runRenderPerformanceDiagnostic) {

        this.container = container || document.body;
        this.captureScreenshot = captureScreenshot;
        this.screenshotCapturePending = false;
        this.runRenderPerformanceDiagnostic = runRenderPerformanceDiagnostic;
        this.renderDiagnosticPending = false;
        this.renderDiagnosticReport = null;

        this.infoCells = {};

        const layout = [
            // ['Camera position', 'cameraPosition'],
            // ['Camera look-at', 'cameraLookAt'],
            // ['Camera up', 'cameraUp'],
            // ['Camera mode', 'orthographicCamera'],
            // ['Cursor position', 'cursorPosition'],
            ['FPS', 'fps'],
            ['First frame', 'firstFrameTime'],
            ['Rendering:', 'renderSplatCount'],
            // ['Sort time', 'sortTime'],
            ['Render window', 'renderWindow'],
            ['Render resolution', 'renderResolution'],
            // ['Focal adjustment', 'focalAdjustment'],
            ['Splat scale', 'splatScale'],
            // ['Point cloud mode', 'pointCloudMode']
        ];

        this.infoPanelContainer = document.createElement('div');
        const style = document.createElement('style');
        style.innerHTML = `

            .infoPanel {
                width: 454px;
                max-width: calc(100% - 20px);
                box-sizing: border-box;
                padding: 10px;
                background-color: rgba(50, 50, 50, 0.85);
                border: #555555 2px solid;
                color: #dddddd;
                border-radius: 10px;
                z-index: 9999;
                font-family: arial;
                font-size: 11pt;
                text-align: left;
                margin: 0;
                top: 10px;
                left:10px;
                position: absolute;
                pointer-events: auto;
            }

            .info-panel-cell {
                margin-bottom: 5px;
                padding-bottom: 2px;
                overflow-wrap: anywhere;
                word-break: break-word;
            }

            .info-panel-table {
                display: table;
                width: 100%;
                table-layout: fixed;
            }

            .label-cell {
                font-weight: bold;
                font-size: 12pt;
                width: 140px;
            }

            .timing-report-button {
                cursor: pointer;
                font: inherit;
                margin-top: 4px;
            }

            .screenshot-button {
                cursor: pointer;
                font: inherit;
            }

            .render-diagnostic-button {
                cursor: pointer;
                font: inherit;
                margin: 4px 4px 0 0;
                min-height: 30px;
                touch-action: manipulation;
            }

        `;
        this.infoPanelContainer.append(style);

        this.infoPanel = document.createElement('div');
        this.infoPanel.className = 'infoPanel';

        const infoTable = document.createElement('div');
        infoTable.className = 'info-panel-table';

        for (let layoutEntry of layout) {
            const row = document.createElement('div');
            row.style.display = 'table-row';
            row.className = 'info-panel-row';

            const labelCell = document.createElement('div');
            labelCell.style.display = 'table-cell';
            labelCell.innerHTML = `${layoutEntry[0]}: `;
            labelCell.classList.add('info-panel-cell', 'label-cell');

            const spacerCell = document.createElement('div');
            spacerCell.style.display = 'table-cell';
            spacerCell.style.width = '10px';
            spacerCell.innerHTML = ' ';
            spacerCell.className = 'info-panel-cell';

            const infoCell = document.createElement('div');
            infoCell.style.display = 'table-cell';
            infoCell.innerHTML = '';
            infoCell.className = 'info-panel-cell';

            this.infoCells[layoutEntry[1]] = infoCell;

            row.appendChild(labelCell);
            row.appendChild(spacerCell);
            row.appendChild(infoCell);

            infoTable.appendChild(row);
        }

        this.screenshotRow = document.createElement('div');
        this.screenshotRow.style.display = 'table-row';
        this.screenshotRow.className = 'info-panel-row';

        const screenshotLabelCell = document.createElement('div');
        screenshotLabelCell.style.display = 'table-cell';
        screenshotLabelCell.textContent = 'Screenshot: ';
        screenshotLabelCell.classList.add('info-panel-cell', 'label-cell');

        const screenshotSpacerCell = document.createElement('div');
        screenshotSpacerCell.style.display = 'table-cell';
        screenshotSpacerCell.style.width = '10px';
        screenshotSpacerCell.textContent = ' ';
        screenshotSpacerCell.className = 'info-panel-cell';

        this.screenshotCell = document.createElement('div');
        this.screenshotCell.style.display = 'table-cell';
        this.screenshotCell.className = 'info-panel-cell';

        this.screenshotButton = document.createElement('button');
        this.screenshotButton.type = 'button';
        this.screenshotButton.className = 'screenshot-button';
        this.screenshotButton.textContent = 'Download PNG';
        this.screenshotButton.addEventListener('click', () => this.downloadScreenshot());

        this.screenshotStatus = document.createElement('div');
        this.screenshotStatus.setAttribute('aria-live', 'polite');

        this.screenshotCell.appendChild(this.screenshotButton);
        this.screenshotCell.appendChild(this.screenshotStatus);
        this.screenshotRow.appendChild(screenshotLabelCell);
        this.screenshotRow.appendChild(screenshotSpacerCell);
        this.screenshotRow.appendChild(this.screenshotCell);
        infoTable.appendChild(this.screenshotRow);

        this.renderDiagnosticRow = document.createElement('div');
        this.renderDiagnosticRow.style.display = 'table-row';
        this.renderDiagnosticRow.className = 'info-panel-row';

        const renderDiagnosticLabelCell = document.createElement('div');
        renderDiagnosticLabelCell.style.display = 'table-cell';
        renderDiagnosticLabelCell.textContent = 'Render diagnosis: ';
        renderDiagnosticLabelCell.classList.add('info-panel-cell', 'label-cell');

        const renderDiagnosticSpacerCell = document.createElement('div');
        renderDiagnosticSpacerCell.style.display = 'table-cell';
        renderDiagnosticSpacerCell.style.width = '10px';
        renderDiagnosticSpacerCell.textContent = ' ';
        renderDiagnosticSpacerCell.className = 'info-panel-cell';

        this.renderDiagnosticCell = document.createElement('div');
        this.renderDiagnosticCell.style.display = 'table-cell';
        this.renderDiagnosticCell.className = 'info-panel-cell';

        this.renderDiagnosticButton = document.createElement('button');
        this.renderDiagnosticButton.type = 'button';
        this.renderDiagnosticButton.className = 'render-diagnostic-button';
        this.renderDiagnosticButton.textContent = 'Run render diagnosis';
        this.renderDiagnosticButton.addEventListener('click', () => this.startRenderPerformanceDiagnostic());

        this.renderDiagnosticStatus = document.createElement('div');
        this.renderDiagnosticStatus.setAttribute('aria-live', 'polite');
        this.renderDiagnosticCell.appendChild(this.renderDiagnosticButton);
        this.renderDiagnosticCell.appendChild(this.renderDiagnosticStatus);
        this.renderDiagnosticRow.appendChild(renderDiagnosticLabelCell);
        this.renderDiagnosticRow.appendChild(renderDiagnosticSpacerCell);
        this.renderDiagnosticRow.appendChild(this.renderDiagnosticCell);
        infoTable.appendChild(this.renderDiagnosticRow);

        this.timingReportRow = document.createElement('div');
        this.timingReportRow.style.display = 'none';
        this.timingReportRow.className = 'info-panel-row';

        const timingReportLabelCell = document.createElement('div');
        timingReportLabelCell.style.display = 'table-cell';
        timingReportLabelCell.textContent = 'Timing JSON: ';
        timingReportLabelCell.classList.add('info-panel-cell', 'label-cell');

        const timingReportSpacerCell = document.createElement('div');
        timingReportSpacerCell.style.display = 'table-cell';
        timingReportSpacerCell.style.width = '10px';
        timingReportSpacerCell.textContent = ' ';
        timingReportSpacerCell.className = 'info-panel-cell';

        this.timingReportCell = document.createElement('div');
        this.timingReportCell.style.display = 'table-cell';
        this.timingReportCell.className = 'info-panel-cell';

        this.timingReportRow.appendChild(timingReportLabelCell);
        this.timingReportRow.appendChild(timingReportSpacerCell);
        this.timingReportRow.appendChild(this.timingReportCell);
        infoTable.appendChild(this.timingReportRow);

        this.infoPanel.appendChild(infoTable);
        this.infoPanelContainer.append(this.infoPanel);
        this.infoPanelContainer.style.display = 'none';
        this.container.appendChild(this.infoPanelContainer);

        this.visible = false;
    }

    async startRenderPerformanceDiagnostic() {
        if (this.renderDiagnosticPending) return;
        if (typeof this.runRenderPerformanceDiagnostic !== 'function') {
            this.renderDiagnosticStatus.textContent = 'Diagnosis unavailable.';
            return;
        }
        this.renderDiagnosticPending = true;
        this.renderDiagnosticReport = null;
        this.renderDiagnosticButton.disabled = true;
        this.renderDiagnosticButton.textContent = 'Running diagnosis…';
        this.renderDiagnosticStatus.textContent = 'Preparing…';
        this.renderDiagnosticDownloadButton?.remove();
        this.renderDiagnosticDownloadButton = null;
        try {
            const report = await this.runRenderPerformanceDiagnostic({
                onProgress: (progress) => {
                    if (this.renderDiagnosticPending && progress?.message) {
                        this.renderDiagnosticStatus.textContent = String(progress.message).slice(0, 160);
                    }
                }
            });
            this.renderDiagnosticReport = report;
            this.renderDiagnosticStatus.textContent = report.status === 'complete' ? 'Complete.' :
                `Finished with status: ${report.status}.`;
            this.renderDiagnosticDownloadButton = document.createElement('button');
            this.renderDiagnosticDownloadButton.type = 'button';
            this.renderDiagnosticDownloadButton.className = 'render-diagnostic-button';
            this.renderDiagnosticDownloadButton.textContent = 'Download diagnostic JSON';
            this.renderDiagnosticDownloadButton.addEventListener('click', () => this.downloadRenderDiagnostic());
            this.renderDiagnosticCell.insertBefore(this.renderDiagnosticDownloadButton, this.renderDiagnosticStatus);
        } catch (error) {
            const message = error?.message || 'Diagnosis failed.';
            this.renderDiagnosticStatus.textContent = `Diagnosis failed: ${String(message).slice(0, 120)}`;
        } finally {
            this.renderDiagnosticPending = false;
            this.renderDiagnosticButton.disabled = false;
            this.renderDiagnosticButton.textContent = 'Run render diagnosis';
        }
    }

    downloadRenderDiagnostic() {
        if (!this.renderDiagnosticReport) return;
        const serializedReport = JSON.stringify(this.renderDiagnosticReport, null, 2);
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const blob = new Blob([serializedReport], {type: 'application/json;charset=utf-8'});
        const objectUrl = URL.createObjectURL(blob);
        const link = document.createElement('a');
        try {
            link.href = objectUrl;
            link.download = `uwa-render-diagnostic-${timestamp}.json`;
            link.style.display = 'none';
            document.body.appendChild(link);
            link.click();
        } finally {
            link.remove();
            window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
        }
    }

    async downloadScreenshot() {
        if (this.screenshotCapturePending) return;
        if (typeof this.captureScreenshot !== 'function') {
            this.screenshotStatus.textContent = 'Capture unavailable.';
            return;
        }

        this.screenshotCapturePending = true;
        this.screenshotButton.disabled = true;
        this.screenshotButton.textContent = 'Capturing…';
        this.screenshotStatus.textContent = 'Waiting for the next frame…';

        try {
            const blob = await this.captureScreenshot();
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const filename = `uwa-screenshot-${timestamp}.png`;
            const objectUrl = URL.createObjectURL(blob);
            const link = document.createElement('a');
            try {
                link.href = objectUrl;
                link.download = filename;
                link.style.display = 'none';
                document.body.appendChild(link);
                link.click();
                this.screenshotStatus.textContent = 'Download ready.';
            } finally {
                link.remove();
                window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
            }
        } catch (error) {
            const message = error?.message || 'Capture failed.';
            this.screenshotStatus.textContent = `Capture failed: ${String(message).slice(0, 120)}`;
        } finally {
            this.screenshotCapturePending = false;
            this.screenshotButton.disabled = false;
            this.screenshotButton.textContent = 'Download PNG';
        }
    }

    setTimingReportPending() {
        this.timingReportCell.replaceChildren();
        this.timingReportCell.textContent = 'Collecting timing data…';
        this.timingReportRow.style.display = 'table-row';
    }

    setTimingReportReady(serializedReport, filename, complete) {
        const safeFilename = String(filename || 'uwa-timing-report.json')
            .replace(/[^a-zA-Z0-9._-]+/g, '_')
            .replace(/^\.+/, '') || 'uwa-timing-report.json';

        this.timingReportCell.replaceChildren();
        const status = document.createElement('div');
        status.textContent = complete ? 'Complete' : 'Partially complete';

        const downloadButton = document.createElement('button');
        downloadButton.type = 'button';
        downloadButton.className = 'timing-report-button';
        downloadButton.textContent = 'Download timing JSON';
        downloadButton.addEventListener('click', () => {
            const blob = new Blob([serializedReport], {type: 'application/json;charset=utf-8'});
            const objectUrl = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = objectUrl;
            link.download = safeFilename;
            link.style.display = 'none';
            document.body.appendChild(link);
            link.click();
            link.remove();
            window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
        });

        this.timingReportCell.appendChild(status);
        this.timingReportCell.appendChild(downloadButton);
        this.timingReportRow.style.display = 'table-row';
    }

    hideTimingReport() {
        this.timingReportCell.replaceChildren();
        this.timingReportRow.style.display = 'none';
    }

    updateCell(name, value) {
        const cell = this.infoCells[name];
        if (cell && cell.innerHTML !== value) cell.innerHTML = value;
    }

    update = function(renderDimensions, renderResolution, cameraPosition, cameraLookAtPosition, cameraUp, orthographicCamera,
                      meshCursorPosition, currentFPS, splatCount, splatRenderCount,
                      splatRenderCountPct, lastSortTime, focalAdjustment, splatScale, pointCloudMode) {

        const cameraPosString = `${cameraPosition.x.toFixed(5)}, ${cameraPosition.y.toFixed(5)}, ${cameraPosition.z.toFixed(5)}`;
        this.updateCell('cameraPosition', cameraPosString);

        if (cameraLookAtPosition) {
            const cla = cameraLookAtPosition;
            const cameraLookAtString = `${cla.x.toFixed(5)}, ${cla.y.toFixed(5)}, ${cla.z.toFixed(5)}`;
            this.updateCell('cameraLookAt', cameraLookAtString);
        }

        const cameraUpString = `${cameraUp.x.toFixed(5)}, ${cameraUp.y.toFixed(5)}, ${cameraUp.z.toFixed(5)}`;
        this.updateCell('cameraUp', cameraUpString);

        this.updateCell('orthographicCamera', orthographicCamera ? 'Orthographic' : 'Perspective');

        if (meshCursorPosition) {
            const cursPos = meshCursorPosition;
            const cursorPosString = `${cursPos.x.toFixed(5)}, ${cursPos.y.toFixed(5)}, ${cursPos.z.toFixed(5)}`;
            this.updateCell('cursorPosition', cursorPosString);
        } else {
            this.updateCell('cursorPosition', 'N/A');
        }

        this.updateCell('fps', `${currentFPS}`);
        this.updateCell('renderWindow', `${renderDimensions.x} x ${renderDimensions.y}`);
        this.updateCell('renderResolution', `${renderResolution.x} x ${renderResolution.y}`);

        this.updateCell('renderSplatCount', `${splatRenderCount} / ${splatCount} (${splatRenderCountPct.toFixed(2)}%)`);

        this.updateCell('sortTime', `${lastSortTime.toFixed(3)} ms`);
        this.updateCell('focalAdjustment', `${focalAdjustment.toFixed(3)}`);
        this.updateCell('splatScale', `${splatScale.toFixed(3)}`);
        this.updateCell('pointCloudMode', `${pointCloudMode}`);
    };

    setFirstFrameTime(label, elapsedMs) {
        if (!this.infoCells.firstFrameTime) return;
        if (elapsedMs === null || elapsedMs === undefined) {
            this.infoCells.firstFrameTime.innerHTML = 'Pending';
            return;
        }
        const prefix = label ? `${label}: ` : '';
        this.infoCells.firstFrameTime.innerHTML = `${prefix}${elapsedMs.toFixed(2)} ms`;
    }

    setContainer(container) {
        if (this.container && this.infoPanelContainer.parentElement === this.container) {
            this.container.removeChild(this.infoPanelContainer);
        }
        if (container) {
            this.container = container;
            this.container.appendChild(this.infoPanelContainer);
            this.infoPanelContainer.style.zIndex = this.container.style.zIndex + 1;
        }
    }

    show() {
        this.infoPanelContainer.style.display = 'block';
        this.visible = true;
    }

    hide() {
        this.infoPanelContainer.style.display = 'none';
        this.visible = false;
    }

}
