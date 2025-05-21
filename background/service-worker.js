import { getPhotoUrlsForAlbum, getPhotoUrlsFromPost, getSinglePhotoHighestResUrl } from '../lib/facebook-api.js';
import { sanitizeFilename, applyTokenToFilename, getOriginalNameFromUrl } from '../lib/utils.js';

const defaultOptions = {
    folderNameRule: "{album_name}",
    fileNameRule: "{index}_{original_name}",
    fileNameIndexPadding: 3,
    imageFormat: "original", // 'jpg', 'png' in future
    skipDownloaded: true,
    concurrentDownloads: 3,
    delayBetweenDownloads: 500
};

let downloadedFileIds = new Set();
let downloadQueue = [];
let activeDownloads = 0;
let currentCollectionName = "";
let currentTabId = null;
let isCancelled = false;
let totalPhotosForCurrentJob = 0;
let processedPhotosForCurrentJob = 0;

// Load downloaded file IDs on startup
chrome.storage.local.get(['downloadedFileIds'], (result) => {
    if (result.downloadedFileIds && Array.isArray(result.downloadedFileIds)) {
        downloadedFileIds = new Set(result.downloadedFileIds);
        console.log(`Loaded ${downloadedFileIds.size} previously downloaded file IDs.`);
    }
});

function saveDownloadedFileIds() {
    chrome.storage.local.set({ downloadedFileIds: Array.from(downloadedFileIds) });
}

function notifyPopup(action, data) {
    if (currentTabId) {
        chrome.runtime.sendMessage({ action, data, to: "popup", from: "background" })
            .catch(err => console.warn("Popup not open or error sending message:", err.message));
    }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "downloadAlbum") {
        const { albumId, tabId, albumName: nameFromPopup } = request;
        currentTabId = tabId;
        isCancelled = false;
        currentCollectionName = nameFromPopup || `album_${albumId}`;
        console.log(`Received request to download album: ${currentCollectionName} (ID: ${albumId})`);
        processAlbumDownload(albumId, nameFromPopup, tabId)
            .then(() => sendResponse({ success: true }))
            .catch(error => {
                console.error("Album download initiation error:", error);
                sendResponse({ success: false, error: error.message });
                notifyPopup("downloadError", { error: error.message });
            });
        return true;
    } else if (request.action === "downloadPhotosFromPost") {
        const { photoIds, postId, tabId } = request;
        currentTabId = tabId;
        isCancelled = false;
        currentCollectionName = `post_${postId || Date.now()}`;
        console.log(`Received request to download photos from post: ${currentCollectionName}`);
        processPhotosDownload(photoIds, currentCollectionName, tabId)
            .then(() => sendResponse({ success: true }))
            .catch(error => {
                console.error("Post photos download initiation error:", error);
                sendResponse({ success: false, error: error.message });
                notifyPopup("downloadError", { error: error.message });
            });
        return true;
    } else if (request.action === "downloadSinglePhoto") {
        const { photoUrl, photoId, tabId } = request;
        currentTabId = tabId;
        isCancelled = false;
        currentCollectionName = `photo_${photoId || Date.now()}`;
        console.log(`Received request to download single photo: ${currentCollectionName}`);
        const photoObject = { id: photoId, url: photoUrl, originalName: getOriginalNameFromUrl(photoUrl) };
        processPhotosDownload([photoObject], currentCollectionName, tabId)
            .then(() => sendResponse({ success: true }))
            .catch(error => {
                console.error("Single photo download initiation error:", error);
                sendResponse({ success: false, error: error.message });
                notifyPopup("downloadError", { error: error.message });
            });
        return true;
    } else if (request.action === "cancelDownload") {
        console.log("Download cancellation requested.");
        isCancelled = true;
        downloadQueue = []; // Clear pending queue
        // Active downloads will check isCancelled flag
        notifyPopup("downloadCancelled", { albumName: currentCollectionName });
        sendResponse({ success: true });
    }
    return false;
});

async function getOptions() {
    return new Promise((resolve) => {
        chrome.storage.local.get({ options: defaultOptions }, (data) => {
            resolve(data.options);
        });
    });
}

async function processAlbumDownload(albumId, nameFromPopup, tabId) {
    const options = await getOptions();
    totalPhotosForCurrentJob = 0; // Reset for new job
    processedPhotosForCurrentJob = 0; // Reset for new job

    try {
        const albumInfo = await getPhotoUrlsForAlbum(albumId, tabId, nameFromPopup);
        if (isCancelled) { console.log("Album download cancelled during info fetch."); return; }

        if (!albumInfo || !albumInfo.photos || albumInfo.photos.length === 0) {
            notifyPopup("downloadError", { error: "No photos found in the album or unable to retrieve album details." });
            return;
        }

        currentCollectionName = albumInfo.albumName; // Update with actual name if fetched
        await processPhotosDownload(albumInfo.photos, currentCollectionName, tabId, options);

    } catch (error) {
        if (isCancelled) return;
        console.error(`Error processing album ${albumId}:`, error);
        notifyPopup("downloadError", { error: `Failed to fetch album: ${error.message}` });
    }
}

async function processPhotosDownload(photosArray, collectionName, tabId, customOptions) {
    if (isCancelled) { console.log("Photo download cancelled before queuing."); return; }
    const options = customOptions || await getOptions();

    totalPhotosForCurrentJob = photosArray.length;
    processedPhotosForCurrentJob = 0;
    notifyPopup("downloadProgress", { processed: 0, total: totalPhotosForCurrentJob, albumName: collectionName });

    let photosToQueue = photosArray;
    if (options.skipDownloaded) {
        const initialCount = photosToQueue.length;
        photosToQueue = photosToQueue.filter(photo => !downloadedFileIds.has(photo.id));
        const skippedCount = initialCount - photosToQueue.length;
        if (skippedCount > 0) {
            console.log(`Skipped ${skippedCount} already downloaded photos.`);
        }
    }

    if (photosToQueue.length === 0) {
        notifyPopup("downloadComplete", { albumName: collectionName, message: "All photos already downloaded or collection is empty." });
        return;
    }

    totalPhotosForCurrentJob = photosToQueue.length; // Update total based on skippable
    if (totalPhotosForCurrentJob === 0 ) { // All were skipped
        notifyPopup("downloadComplete", { albumName: collectionName, message: "All photos already downloaded." });
        return;
    }
    notifyPopup("downloadProgress", { processed: 0, total: totalPhotosForCurrentJob, albumName: collectionName });


    const date = new Date();
    const formattedDate = {
        'YYYY-MM-DD': `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`,
        'MM-DD-YYYY': `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}-${date.getFullYear()}`,
        'DD-MM-YYYY': `${String(date.getDate()).padStart(2, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${date.getFullYear()}`,
    };
    const formattedTime = {
        'HH-MM-SS': `${String(date.getHours()).padStart(2, '0')}-${String(date.getMinutes()).padStart(2, '0')}-${String(date.getSeconds()).padStart(2, '0')}`
    };

    const baseFolderName = applyTokenToFilename(options.folderNameRule, {
        album_name: collectionName,
        owner_name: "FacebookUser", // Placeholder - real extraction needed
        'date_YYYY-MM-DD': formattedDate['YYYY-MM-DD'],
        'date_MM-DD-YYYY': formattedDate['MM-DD-YYYY'],
        'date_DD-MM-YYYY': formattedDate['DD-MM-YYYY'],
        timestamp_unix: Math.floor(date.getTime() / 1000),
        year: date.getFullYear(),
        month: String(date.getMonth() + 1).padStart(2, '0'),
        day: String(date.getDate()).padStart(2, '0')
    });

    downloadQueue = photosToQueue.map((photo, index) => ({
        url: photo.url,
        id: photo.id,
        originalName: photo.originalName || `${photo.id || `photo_${index}`}.jpg`,
        albumName: collectionName,
        baseFolderName: sanitizeFilename(baseFolderName),
        index: index + 1,
        tabId: tabId,
        options: options,
        date, // Pass the date object for file naming
        formattedDate,
        formattedTime
    }));

    console.log(`Queued ${downloadQueue.length} photos for download from ${collectionName}.`);
    startProcessingQueue();
}

function startProcessingQueue() {
    if (isCancelled) {
        console.log("Queue processing cancelled.");
        isDownloading = false;
        downloadQueue = [];
        activeDownloads = 0;
        return;
    }
    if (downloadQueue.length === 0 && activeDownloads === 0) {
        isDownloading = false;
        console.log("Download queue empty and no active downloads.");
        if (totalPhotosForCurrentJob > 0) { // Only send complete if a job was actually started
            notifyPopup("downloadComplete", { albumName: currentCollectionName, message: "All downloads processed." });
        }
        return;
    }

    isDownloading = true;
    const optionsPromise = getOptions(); // Get fresh options for each batch

    optionsPromise.then(options => {
        while (downloadQueue.length > 0 && activeDownloads < options.concurrentDownloads) {
            if (isCancelled) break;
            const item = downloadQueue.shift();
            activeDownloads++;
            downloadPhoto(item)
                .finally(() => {
                    activeDownloads--;
                    processedPhotosForCurrentJob++;
                    notifyPopup("downloadProgress", { processed: processedPhotosForCurrentJob, total: totalPhotosForCurrentJob, albumName: item.albumName });
                    if (!isCancelled) {
                        setTimeout(() => startProcessingQueue(), options.delayBetweenDownloads);
                    } else if(activeDownloads === 0 && downloadQueue.length === 0) {
                        isDownloading = false;
                        console.log("All active downloads finished after cancellation.");
                    }
                });
        }
        if (downloadQueue.length === 0 && activeDownloads === 0 && !isCancelled) {
            isDownloading = false;
            if (totalPhotosForCurrentJob > 0 && processedPhotosForCurrentJob >= totalPhotosForCurrentJob) {
                notifyPopup("downloadComplete", { albumName: currentCollectionName, message: "All downloads processed." });
            }
        }
    });
}

async function downloadPhoto(item) {
    if (isCancelled) {
        console.log(`Skipping download for ${item.id} due to cancellation.`);
        return Promise.resolve();
    }

    const paddedIndex = String(item.index).padStart(item.options.fileNameIndexPadding || 3, '0');
    const rawIndex = String(item.index);

    const fileName = applyTokenToFilename(item.options.fileNameRule, {
        index: paddedIndex,
        index_raw: rawIndex,
        original_name: item.originalName,
        photo_id: item.id,
        album_name: item.albumName,
        timestamp_unix: Math.floor(item.date.getTime() / 1000),
        'date_YYYY-MM-DD': item.formattedDate['YYYY-MM-DD'],
        'time_HH-MM-SS': item.formattedTime['HH-MM-SS'],
        year: item.date.getFullYear(),
        month: String(item.date.getMonth() + 1).padStart(2, '0'),
        day: String(item.date.getDate()).padStart(2, '0'),
        hour: String(item.date.getHours()).padStart(2, '0'),
        minute: String(item.date.getMinutes()).padStart(2, '0'),
        second: String(item.date.getSeconds()).padStart(2, '0')
    });

    const sanitizedFilename = sanitizeFilename(fileName);
    const fullPath = item.baseFolderName ? `${item.baseFolderName}/${sanitizedFilename}` : sanitizedFilename;

    console.log(`Downloading: ${item.originalName} (ID: ${item.id}) as ${fullPath}`);

    return new Promise(async (resolve, reject) => {
        try {
            // Placeholder for actual image format conversion if item.options.imageFormat is not 'original'
            // For now, we download directly.

            const response = await fetch(item.url);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status} for ${item.originalName}`);
            }
            const blob = await response.blob();
            const objectURL = URL.createObjectURL(blob);

            chrome.downloads.download({
                url: objectURL,
                filename: fullPath,
                saveAs: false
            }, (downloadId) => {
                URL.revokeObjectURL(objectURL);
                if (chrome.runtime.lastError) {
                    console.error(`Download failed for ${item.originalName}:`, chrome.runtime.lastError.message);
                    notifyPopup("downloadError", { error: `Failed for ${item.originalName}: ${chrome.runtime.lastError.message.substring(0,100)}` });
                    reject(new Error(chrome.runtime.lastError.message));
                } else if (downloadId === undefined) {
                    // This can happen if the download is disallowed by browser settings or another extension
                    console.error(`Download undefined for ${item.originalName}. Possible browser restriction.`);
                    notifyPopup("downloadError", { error: `Download for ${item.originalName} was blocked or failed to start.` });
                    reject(new Error(`Download for ${item.originalName} was blocked.`));
                }
                else {
                    downloadedFileIds.add(item.id);
                    saveDownloadedFileIds();
                    resolve();
                }
            });
        } catch (error) {
            if (isCancelled) {
                console.log(`Download fetch for ${item.id} aborted.`);
                resolve(); // Resolve so queue processing can continue for other non-cancelled items
                return;
            }
            console.error(`Error downloading ${item.originalName}:`, error);
            notifyPopup("downloadError", { error: `Failed to download ${item.originalName}: ${error.message.substring(0,100)}` });
            reject(error);
        }
    });
}


// Initialize rules
chrome.runtime.onInstalled.addListener(() => {
    console.log("Extension installed/updated. Setting up rules.");
    chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [1, 2], // IDs from rules.json
        addRules: [
            {
                "id": 1,
                "priority": 1,
                "action": {
                    "type": "modifyHeaders",
                    "responseHeaders": [
                        { "header": "cross-origin-embedder-policy", "operation": "remove" },
                        { "header": "cross-origin-opener-policy", "operation": "remove" },
                        { "header": "cross-origin-resource-policy", "operation": "remove" }
                    ]
                },
                "condition": {
                    "urlFilter": "*://*.fbcdn.net/*",
                    "resourceTypes": ["image", "xmlhttprequest", "media"]
                }
            },
            {
                "id": 2,
                "priority": 1,
                "action": {
                    "type": "modifyHeaders",
                    "requestHeaders": [
                        // Setting origin and referer can sometimes help with direct image access
                        // but might also be risky if Facebook changes its policies.
                        // Use with caution and test thoroughly.
                        { "header": "Origin", "operation": "set", "value": "https://www.facebook.com" },
                        { "header": "Referer", "operation": "set", "value": "https://www.facebook.com/" }
                    ]
                },
                "condition": {
                    "urlFilter": "*://*.fbcdn.net/*",
                    "resourceTypes": ["image", "media"]
                }
            }
        ]
    }, () => {
        if (chrome.runtime.lastError) {
            console.error("Error updating declarativeNetRequest rules:", chrome.runtime.lastError);
        } else {
            console.log("DeclarativeNetRequest rules updated successfully.");
        }
    });
});


console.log("Open Source Facebook Photo Downloader Service Worker Ready.");

// Keep service worker alive during download
let keepAliveInterval;
chrome.downloads.onCreated.addListener(() => {
    if (!keepAliveInterval && (activeDownloads > 0 || downloadQueue.length > 0)) {
        keepAliveInterval = setInterval(() => {
            // console.log("Keep alive ping for downloads.");
            if (activeDownloads === 0 && downloadQueue.length === 0) {
                clearInterval(keepAliveInterval);
                keepAliveInterval = null;
            }
        }, 25000); // Ping every 25 seconds
    }
});

chrome.downloads.onChanged.addListener((delta) => {
    if (delta.state && delta.state.current === 'complete') {
        // A download finished
    }
    if (activeDownloads === 0 && downloadQueue.length === 0 && keepAliveInterval) {
        clearInterval(keepAliveInterval);
        keepAliveInterval = null;
    }
});