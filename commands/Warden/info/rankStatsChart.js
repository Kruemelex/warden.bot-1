'use strict';

const QuickChart = require('quickchart-js');

const DEFAULT_BRAND_COLOR = '#ff7100';
const MIN_CHART_HEIGHT = 360;
const MAX_CHART_HEIGHT = 900;
const CHART_ROW_HEIGHT = 42;

function normalizeCount(value) {
    const count = Number(value);
    return Number.isFinite(count) && count > 0 ? Math.trunc(count) : 0;
}

function normalizeRankEntries(entries) {
    if (!Array.isArray(entries)) return [];
    return entries.map((entry, configuredIndex) => ({
        configuredIndex,
        memberCount: normalizeCount(entry?.memberCount),
        name: String(entry?.name ?? '').trim(),
    })).filter((entry) => entry.name);
}

function orderRankEntriesByRarity(entries) {
    return normalizeRankEntries(entries).sort((left, right) => (
        left.memberCount - right.memberCount || left.configuredIndex - right.configuredIndex
    ));
}

function getChartHeight(entryCount) {
    return Math.min(MAX_CHART_HEIGHT, Math.max(
        MIN_CHART_HEIGHT,
        (Number(entryCount) || 0) * CHART_ROW_HEIGHT + 110,
    ));
}

function buildRankStatsChartConfig(entries, brandColor = DEFAULT_BRAND_COLOR) {
    const orderedEntries = orderRankEntriesByRarity(entries);
    const color = String(brandColor || DEFAULT_BRAND_COLOR);

    return {
        type: 'horizontalBar',
        data: {
            labels: orderedEntries.map((entry) => entry.name),
            datasets: [{
                backgroundColor: color,
                borderColor: color,
                borderWidth: 1,
                data: orderedEntries.map((entry) => entry.memberCount),
                label: 'Current members',
            }],
        },
        options: {
            animation: false,
            legend: { display: false },
            layout: {
                padding: { bottom: 8, left: 8, right: 42, top: 8 },
            },
            maintainAspectRatio: false,
            plugins: {
                datalabels: {
                    align: 'end',
                    anchor: 'end',
                    color: '#ffffff',
                    font: { weight: 'bold' },
                    formatter: (value) => String(value),
                },
            },
            scales: {
                xAxes: [{
                    gridLines: { color: 'rgba(255, 255, 255, 0.14)' },
                    ticks: {
                        beginAtZero: true,
                        fontColor: '#ffffff',
                        precision: 0,
                    },
                }],
                yAxes: [{
                    barPercentage: 0.72,
                    gridLines: { display: false },
                    ticks: {
                        fontColor: '#ffffff',
                        fontSize: 14,
                    },
                }],
            },
            title: {
                display: true,
                fontColor: '#ffffff',
                fontSize: 18,
                text: 'Current rank membership',
            },
            tooltips: {
                callbacks: {
                    label: (tooltipItem) => `${tooltipItem.xLabel} current members`,
                },
            },
        },
    };
}

function createRankStatsChartUrl(entries, brandColor, QuickChartClass = QuickChart) {
    const chart = new QuickChartClass();
    chart.setWidth(900);
    chart.setHeight(getChartHeight(entries?.length));
    chart.setBackgroundColor('transparent');
    chart.setConfig(buildRankStatsChartConfig(entries, brandColor));
    return chart.getUrl();
}

module.exports = {
    buildRankStatsChartConfig,
    createRankStatsChartUrl,
    getChartHeight,
    orderRankEntriesByRarity,
};
