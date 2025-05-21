const folderNameRuleInput = document.getElementById('folderNameRule');
const fileNameRuleInput = document.getElementById('fileNameRule');
const fileNameIndexPaddingInput = document.getElementById('fileNameIndexPadding');
const imageFormatSelect = document.getElementById('imageFormat');
const skipDownloadedCheckbox = document.getElementById('skipDownloaded');
const concurrentDownloadsInput = document.getElementById('concurrentDownloads');
const delayBetweenDownloadsInput = document.getElementById('delayBetweenDownloads');

const saveOptionsBtn = document.getElementById('saveOptionsBtn');
const resetOptionsBtn = document.getElementById('resetOptionsBtn');
const saveStatusDiv = document.getElementById('saveStatus');

const defaultOptions = {
    folderNameRule: "{album_name}",
    fileNameRule: "{index}_{original_name}",
    fileNameIndexPadding: 3,
    imageFormat: "original",
    skipDownloaded: true,
    concurrentDownloads: 3,
    delayBetweenDownloads: 500
};

function saveOptions() {
    const options = {
        folderNameRule: folderNameRuleInput.value.trim() || defaultOptions.folderNameRule,
        fileNameRule: fileNameRuleInput.value.trim() || defaultOptions.fileNameRule,
        fileNameIndexPadding: parseInt(fileNameIndexPaddingInput.value, 10) || defaultOptions.fileNameIndexPadding,
        imageFormat: imageFormatSelect.value,
        skipDownloaded: skipDownloadedCheckbox.checked,
        concurrentDownloads: parseInt(concurrentDownloadsInput.value, 10) || defaultOptions.concurrentDownloads,
        delayBetweenDownloads: parseInt(delayBetweenDownloadsInput.value, 10) || defaultOptions.delayBetweenDownloads,
    };

    // Clamp values
    options.fileNameIndexPadding = Math.max(0, Math.min(10, options.fileNameIndexPadding));
    options.concurrentDownloads = Math.max(1, Math.min(10, options.concurrentDownloads));
    options.delayBetweenDownloads = Math.max(0, Math.min(10000, options.delayBetweenDownloads));


    chrome.storage.local.set({ options }, () => {
        saveStatusDiv.textContent = 'Options saved!';
        saveStatusDiv.style.color = 'green';
        setTimeout(() => {
            saveStatusDiv.textContent = '';
        }, 2500);
    });
}

function loadOptions() {
    chrome.storage.local.get({ options: defaultOptions }, (data) => {
        const opts = data.options;
        folderNameRuleInput.value = opts.folderNameRule;
        fileNameRuleInput.value = opts.fileNameRule;
        fileNameIndexPaddingInput.value = opts.fileNameIndexPadding === undefined ? defaultOptions.fileNameIndexPadding : opts.fileNameIndexPadding;
        imageFormatSelect.value = opts.imageFormat;
        skipDownloadedCheckbox.checked = opts.skipDownloaded;
        concurrentDownloadsInput.value = opts.concurrentDownloads;
        delayBetweenDownloadsInput.value = opts.delayBetweenDownloads;
    });
}

function resetOptions() {
    if (confirm("Are you sure you want to reset all options to their defaults?")) {
        chrome.storage.local.set({ options: defaultOptions }, () => {
            loadOptions(); // Reload options into the form
            saveStatusDiv.textContent = 'Options reset to defaults.';
            saveStatusDiv.style.color = 'orange';
            setTimeout(() => {
                saveStatusDiv.textContent = '';
            }, 2500);
        });
    }
}

document.addEventListener('DOMContentLoaded', loadOptions);
saveOptionsBtn.addEventListener('click', saveOptions);
resetOptionsBtn.addEventListener('click', resetOptions);