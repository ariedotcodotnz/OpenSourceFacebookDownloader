const statusDiv = document.getElementById('status');
const albumInfoDiv = document.getElementById('albumInfo');
const albumNameSpan = document.getElementById('albumName');
const photoCountSpan = document.getElementById('photoCount');
const postInfoDiv = document.getElementById('postInfo');
const postPhotoCountSpan = document.getElementById('postPhotoCount');

const downloadBtn = document.getElementById('downloadBtn');
const cancelBtn = document.getElementById('cancelBtn');
const openOptionsBtn = document.getElementById('openOptionsBtn');

const progressContainer = document.getElementById('progressContainer');
const progressStatusSpan = document.getElementById('progressStatus');
const progressText = document.getElementById('progressText');
const progressBar = document.getElementById('progressBar');
const errorMessagesDiv = document.getElementById('errorMessages');

let currentTabId = null;
let pageContextCache = null;

async function getCurrentTab() {
    let queryOptions = { active: true, currentWindow: true };
    let [tab] = await chrome.tabs.query(queryOptions);
    return tab;
}

function showProgress(processed, total, albumName = "photos") {
    progressContainer.style.display = 'block';
    cancelBtn.style.display = 'block';
    downloadBtn.disabled = true;
    openOptionsBtn.disabled = true;

    progressStatusSpan.textContent = `Downloading ${albumName}...`;
    progressText.textContent = `${processed}/${total}`;
    progressBar.value = total > 0 ? (processed / total) * 100 : 0;
    errorMessagesDiv.textContent = '';
}

function hideProgress() {
    progressContainer.style.display = 'none';
    cancelBtn.style.display = 'none';
    downloadBtn.disabled = false;
    openOptionsBtn.disabled = false;
}

function showError(message) {
    errorMessagesDiv.textContent = message;
    hideProgress();
    downloadBtn.disabled = false;
    openOptionsBtn.disabled = false;
    // Re-enable download button if an error occurs
    if (pageContextCache) {
        updateUIForContext(pageContextCache);
    }
}

async function detectPageContext() {
    const tab = await getCurrentTab();
    if (!tab || !tab.id || !tab.url || !tab.url.includes("facebook.com")) {
        statusDiv.textContent = "Not on a Facebook page.";
        pageContextCache = null;
        updateUIForContext(null);
        return null;
    }
    currentTabId = tab.id;
    statusDiv.textContent = "Analyzing Facebook page...";

    try {
        const response = await chrome.tabs.sendMessage(tab.id, { action: "getPageContext" });
        if (chrome.runtime.lastError) {
            console.error("Error sending message:", chrome.runtime.lastError.message);
            showError("Error communicating with page. Please refresh the page and try again.");
            pageContextCache = null;
            return null;
        }
        pageContextCache = response; // Cache the context
        return response;
    } catch (error) {
        console.error("Failed to get page context:", error);
        let errorMsg = "Could not detect page context.";
        if (error.message && error.message.includes("Receiving end does not exist")) {
            errorMsg = "Please refresh the Facebook page and try again.";
        }
        showError(errorMsg);
        pageContextCache = null;
        return null;
    }
}

function updateUIForContext(context) {
    albumInfoDiv.style.display = 'none';
    postInfoDiv.style.display = 'none';
    downloadBtn.style.display = 'none';
    errorMessagesDiv.textContent = ''; // Clear previous errors

    if (!context) {
        statusDiv.textContent = "Could not determine Facebook page context.";
        return;
    }

    downloadBtn.disabled = false; // Ensure enabled if context is found

    if (context.isAlbum && context.albumId) {
        albumNameSpan.textContent = context.albumName || 'Unnamed Album';
        photoCountSpan.textContent = context.photoCount !== undefined ? context.photoCount : "Loading...";
        albumInfoDiv.style.display = 'block';
        downloadBtn.textContent = `Download Album (${context.photoCount > 0 ? context.photoCount : '...'})`;
        downloadBtn.style.display = 'block';
        downloadBtn.dataset.type = 'album';
        downloadBtn.dataset.albumId = context.albumId;
        statusDiv.textContent = "Album detected.";
    } else if (context.isPostWithPhotos && context.photoIds && context.photoIds.length > 0) {
        postPhotoCountSpan.textContent = context.photoIds.length;
        postInfoDiv.style.display = 'block';
        downloadBtn.textContent = `Download ${context.photoIds.length} Photos`;
        downloadBtn.style.display = 'block';
        downloadBtn.dataset.type = 'post';
        downloadBtn.dataset.postId = context.postId;
        downloadBtn.dataset.photoIds = JSON.stringify(context.photoIds);
        statusDiv.textContent = "Post with multiple photos detected.";
    } else if (context.isSinglePhotoPage && context.photoUrl) {
        statusDiv.textContent = "Single photo page detected.";
        downloadBtn.textContent = "Download This Photo";
        downloadBtn.style.display = 'block';
        downloadBtn.dataset.type = 'single';
        downloadBtn.dataset.photoUrl = context.photoUrl;
        downloadBtn.dataset.photoId = context.photoId;
    } else {
        statusDiv.textContent = "No downloadable photos/album found here.";
    }
}

downloadBtn.addEventListener('click', async () => {
    if (!currentTabId || !pageContextCache) return;

    downloadBtn.disabled = true;
    openOptionsBtn.disabled = true;
    cancelBtn.style.display = 'block';
    errorMessagesDiv.textContent = '';

    const type = downloadBtn.dataset.type;

    try {
        if (type === 'album') {
            statusDiv.textContent = "Fetching album details...";
            showProgress(0, parseInt(photoCountSpan.textContent) || 0, albumNameSpan.textContent);
            await chrome.runtime.sendMessage({
                action: "downloadAlbum",
                tabId: currentTabId,
                albumId: downloadBtn.dataset.albumId,
                albumName: pageContextCache.albumName
            });
        } else if (type === 'post') {
            statusDiv.textContent = "Starting post photos download...";
            showProgress(0, pageContextCache.photoIds.length, "Post Photos");
            await chrome.runtime.sendMessage({
                action: "downloadPhotosFromPost",
                tabId: currentTabId,
                postId: downloadBtn.dataset.postId,
                photoIds: JSON.parse(downloadBtn.dataset.photoIds || "[]")
            });
        } else if (type === 'single') {
            statusDiv.textContent = "Downloading single photo...";
            showProgress(0, 1, "Single Photo");
            await chrome.runtime.sendMessage({
                action: "downloadSinglePhoto",
                tabId: currentTabId,
                photoUrl: downloadBtn.dataset.photoUrl,
                photoId: downloadBtn.dataset.photoId
            });
        }
    } catch (error) {
        console.error(`Error starting ${type} download:`, error);
        showError("Error: " + error.message);
    }
});

cancelBtn.addEventListener('click', async () => {
    if (currentTabId) {
        chrome.runtime.sendMessage({ action: "cancelDownload", tabId: currentTabId });
        statusDiv.textContent = "Cancelling download...";
        cancelBtn.disabled = true;
    }
});


openOptionsBtn.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "downloadProgress") {
        const { processed, total, albumName } = request.data;
        showProgress(processed, total, albumName);
    } else if (request.action === "downloadComplete") {
        statusDiv.textContent = `Download complete: ${request.data.albumName || 'Photos'}!`;
        progressBar.value = 100;
        hideProgress();
        detectPageContext().then(updateUIForContext);
    } else if (request.action === "downloadError") {
        showError("Error: " + request.data.error);
        // Re-detect to re-enable appropriate buttons
        detectPageContext().then(updateUIForContext);
    } else if (request.action === "downloadCancelled") {
        statusDiv.textContent = "Download cancelled.";
        hideProgress();
        detectPageContext().then(updateUIForContext);
    } else if (request.action === "albumPhotoCountUpdated") {
        if (pageContextCache && pageContextCache.isAlbum) {
            pageContextCache.photoCount = request.data.count;
            updateUIForContext(pageContextCache);
        }
    }
});

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    detectPageContext().then(updateUIForContext);
});