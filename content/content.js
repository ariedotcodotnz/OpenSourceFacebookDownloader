console.log("Open Source Facebook Photo Downloader Content Script Loaded (v1.1.0).");

function getMetaProperty(propertyName) {
    const meta = document.querySelector(`meta[property="${propertyName}"]`);
    return meta ? meta.getAttribute('content') : null;
}

function findTextInParents(element, text, maxDepth = 5) {
    let current = element;
    for (let i = 0; i < maxDepth && current; i++) {
        if (current.textContent && current.textContent.toLowerCase().includes(text.toLowerCase())) {
            return true;
        }
        current = current.parentElement;
    }
    return false;
}

function isLikelyAlbumPage() {
    // More robust checks for album pages
    // Look for elements that typically signify an album
    if (document.querySelector('a[href*="/photos/a."]') || document.querySelector('a[href*="/media/set/?set=a."]')) {
        return true;
    }
    // Check for common album title patterns or containers
    const heading = document.querySelector('h1, h2, [role="heading"]');
    if (heading && (heading.textContent.toLowerCase().includes('album') || findTextInParents(heading, 'album'))) {
        return true;
    }
    if (document.querySelector('[data-pagelet*="MediaViewerAlbum"]')) return true; // Newer FB UIs
    if (document.querySelector('[aria-label*="Album"], [aria-label*="album"]')) return true;

    // Check URL patterns for albums
    const url = window.location.href;
    if (url.includes('/photos/album/') || url.includes('media/set/?set=a.') || url.includes('/photos_albums/')) {
        return true;
    }

    return false;
}

// Helper function to log all potential image elements for debugging
function logPotentialImages() {
    console.log("Debugging images on page:");

    const imageSelectors = [
        'img[data-visualcompletion="media-vc-image"]',
        'div[data-visualcompletion="photo-layout"] img',
        'object[type="image/jpeg"]',
        'img.spotlight',
        'img[data-imgperflogname="media_viewer_image"]',
        'a[href*="/photos/"] > img',
        'img[class*="photo"]',
        'img[class*="image"]',
        '[role="main"] img'
    ];

    imageSelectors.forEach(selector => {
        const elements = document.querySelectorAll(selector);
        console.log(`Found ${elements.length} elements matching selector: ${selector}`);

        // Log details of first 5 elements per selector
        Array.from(elements).slice(0, 5).forEach((el, i) => {
            const rect = el.getBoundingClientRect();
            console.log(`${selector} #${i}: src=${el.src?.substring(0, 100)}, width=${rect.width}, height=${rect.height}`);
        });
    });

    // Check for image-like elements in the page
    document.querySelectorAll('img').forEach((img, i) => {
        if (i < 20) { // Limit to first 20 to avoid console spam
            const rect = img.getBoundingClientRect();
            if (rect.width > 100 && rect.height > 100) {
                console.log(`Large image #${i}: src=${img.src?.substring(0, 100)}, width=${rect.width}, height=${rect.height}`);
            }
        }
    });
}

function getAlbumInfo() {
    const url = window.location.href;
    let albumId = null;
    let albumName = "Facebook Album";
    let photoCount = 0;

    // Try to get album ID from URL - expand pattern matching
    let albumMatch = url.match(/set=a\.(\d+)/) ||
        url.match(/albums\/(\d+)/) ||
        url.match(/album\/(\d+)/) ||
        url.match(/album_id=(\d+)/);
    if (albumMatch && albumMatch[1]) {
        albumId = albumMatch[1];
    }

    // Try to get album name - expanded selector patterns
    const albumTitleElement =
        document.querySelector('h1[data-gt=\'{"tn":"%2C"}\'] span') || // Older layout
        document.querySelector('h1 span[dir="auto"]') || // Another older layout
        document.querySelector('h2[data-testid="album-title"]') || // Test ID
        document.querySelector('div[role="main"] h1') || // Generic h1 in main content
        document.querySelector('span[data-testid="album-title"]') ||
        document.querySelector('strong > span[style*="text-decoration: underline;"]') || // For "Mobile Uploads" etc.
        document.querySelector('div[role="button"] > span > span > span[dir="auto"]') || // Complex nested span for title
        document.querySelector('div.bi6gxh9e.a7woen2v > span.d2edcug0.hpfvmrgz.qv66sw1b.c1et5uql.lr9zc1uh.a8c37x1j.fe6kdd0r.mau55g9w.c8b282yb.d3f4x2em.mdeji52x.a5q79mjw.g1cxx5fr.lrazzd5p.oo9gr5id') || // Very specific selector, likely to break
        document.querySelector('[data-pagelet="TahoeRightRail"] h2 span') || // Right rail album title
        document.querySelector('div[aria-labelledby] h2[dir="auto"]') || // Accessible heading
        document.querySelector('div[data-pagelet="ProfileAppSection_0"] span[dir="auto"] > span[dir="auto"] > h2[dir="auto"] > span[dir="auto"]') || // Another Profile Photos title
        document.querySelector('[role="heading"][aria-level="1"]') || // Accessible heading element
        document.querySelector('[role="heading"][aria-level="2"]') || // Secondary heading element
        getMetaProperty("og:title");

    if (albumTitleElement) {
        albumName = albumTitleElement.textContent.trim();
    } else {
        // Fallback using document title if it seems like an album page
        if (isLikelyAlbumPage() && document.title) {
            albumName = document.title.replace(" | Facebook", "").trim();
        }
    }

    // Try to get photo count - expanded patterns
    const photoCountElements = Array.from(document.querySelectorAll('span, div, a'));
    const photoCountRegex = /(\d+)\s+(photos?|items|pictures|images)/i;
    for (const el of photoCountElements) {
        if (el.textContent) {
            const match = el.textContent.match(photoCountRegex);
            if (match && parseInt(match[1]) > 0) {
                photoCount = parseInt(match[1]);
                break;
            }
        }
    }

    // Fallback for some layouts - more aggressive image finding
    if (photoCount === 0) {
        const images = document.querySelectorAll(
            'img[data-visualcompletion="media-vc-image"], ' +
            'a[href*="/photos/"] > img, ' +
            'div[data-visualcompletion="photo-layout"] img, ' +
            '[role="main"] img[src*="fbcdn"], ' +
            'img[class*="photo"]'
        );

        // Filter by size to exclude icons, etc.
        const largeImages = Array.from(images).filter(img => {
            const rect = img.getBoundingClientRect();
            return rect.width > 100 && rect.height > 100;
        });

        if (largeImages.length > 0 && isLikelyAlbumPage()) {
            photoCount = largeImages.length;
            console.log(`Found ${photoCount} potential photos by image size filtering`);
        }
    }

    // If albumId is still null, try to extract from a link on the page
    if (!albumId) {
        // Enhanced link selectors
        const albumLinkSelectors = [
            'a[href*="/media/set/?set=a."]',
            'a[href*="/photos/a."]',
            'a[href*="/albums/"]',
            'a[href*="/photos/album/"]'
        ];

        for (const selector of albumLinkSelectors) {
            const albumLinkElement = document.querySelector(selector);
            if (albumLinkElement && albumLinkElement.href) {
                albumMatch = albumLinkElement.href.match(/set=a\.(\d+)/) ||
                    albumLinkElement.href.match(/photos\/a\.(\d+)/) ||
                    albumLinkElement.href.match(/album\/(\d+)/) ||
                    albumLinkElement.href.match(/albums\/(\d+)/);

                if (albumMatch && albumMatch[1]) {
                    albumId = albumMatch[1];
                    break;
                }
            }
        }
    }

    // Another attempt for album ID from profile photos link
    if (!albumId && (albumName.toLowerCase().includes("profile pictures") || albumName.toLowerCase().includes("cover photos"))) {
        const profileLink = document.querySelector('a[href*="/photos_by"]'); // Link to user's main photos page
        if (profileLink) {
            const userIdMatch = profileLink.href.match(/\.com\/([\w.]+)\/photos_by/);
            if (userIdMatch && userIdMatch[1]) {
                albumId = `${userIdMatch[1]}_${albumName.toLowerCase().includes("profile") ? "profile" : "cover"}`; // Create a pseudo-ID
            }
        }
    }

    // More aggressive check if it's likely an album but ID is missing
    if (!albumId && isLikelyAlbumPage()) {
        // Try to find a photo link that might contain an album reference
        const anyPhotoLink = document.querySelector('a[href*="/photos/a."]');
        if (anyPhotoLink && anyPhotoLink.href) {
            albumMatch = anyPhotoLink.href.match(/set=a\.(\d+)/) || anyPhotoLink.href.match(/photos\/a\.(\d+)/);
            if (albumMatch && albumMatch[1]) {
                albumId = albumMatch[1];
            }
        }
        if (!albumId) { // Last resort for album-like pages
            albumId = `scraped_album_${Date.now()}`; // Fallback ID
            console.warn("Likely an album page, but could not determine a Facebook Album ID. Using a generated ID.");
        }
    }

    // Debug info
    if (albumId) {
        console.log(`Album detected: ID=${albumId}, Name=${albumName}, PhotoCount=${photoCount}`);
        // Call our debug function to log potential images
        logPotentialImages();
        return { isAlbum: true, albumId, albumName, photoCount };
    }
    return null;
}

function getPostOrCollectionInfo() {
    const url = window.location.href;

    // Check if it's a permalink/story page or a photo viewer that isn't an album
    if (url.includes("photo.php") || url.includes("/photos/") || url.includes("permalink.php") ||
        url.includes("/posts/") || url.includes("/watch/") || url.includes("?story_fbid=")) {

        console.log("Detected potential post or photo page");

        // Call our debug function to log potential images
        logPotentialImages();

        // Prioritize elements that are definitely part of a collection or main content
        const mainContentAreas = Array.from(document.querySelectorAll(
            '[role="main"], ' +
            '[data-pagelet*="FeedUnit"], ' +
            '[data-pagelet*="PhotoViewer"], ' +
            'div[aria-label*="attachment"], ' +
            '[class*="feed"], ' +
            '[class*="photo"], ' +
            '[class*="story"]'
        ));

        let photoElements = [];

        if (mainContentAreas.length > 0) {
            console.log(`Found ${mainContentAreas.length} main content areas`);
            mainContentAreas.forEach(area => {
                const areaPhotos = Array.from(area.querySelectorAll(
                    'img[data-visualcompletion="media-vc-image"], ' +
                    'div[data-visualcompletion="photo-layout"] img, ' +
                    'object[type="image/jpeg"], ' +
                    'img.spotlight, ' +
                    'img[data-imgperflogname="media_viewer_image"], ' +
                    'img[src*="fbcdn.net"], ' +
                    'img[class*="image"], ' +
                    'img[class*="photo"]'
                ));
                photoElements.push(...areaPhotos);
                console.log(`Found ${areaPhotos.length} photos in content area`);
            });
        } else {
            // Fallback to page-wide query if specific main content areas aren't found
            photoElements = Array.from(document.querySelectorAll(
                'img[data-visualcompletion="media-vc-image"], ' +
                'div[data-visualcompletion="photo-layout"] img, ' +
                'object[type="image/jpeg"], ' +
                'img.spotlight, ' +
                'img[data-imgperflogname="media_viewer_image"], ' +
                'img[src*="fbcdn.net"], ' +
                'img[class*="image"], ' +
                'img[class*="photo"]'
            ));
            console.log(`Fallback: Found ${photoElements.length} potential photos across the page`);
        }

        // Filter out tiny icons, profile pics in comments, etc. by size (heuristic)
        photoElements = photoElements.filter(img => {
            const rect = img.getBoundingClientRect();
            const isLargeEnough = (rect.width > 100 && rect.height > 100);
            const notInComplementary = !img.closest('[role="complementary"]'); // Exclude sidebars
            return isLargeEnough && notInComplementary;
        });

        console.log(`After filtering: ${photoElements.length} photos remain`);

        const photoData = photoElements.map((img, index) => {
            let src = img.src;
            let highResSrc = null;

            // Try to get higher resolution image from 'object' tag if img is inside it
            const parentObject = img.closest('object[type="image/jpeg"]');
            if (parentObject && parentObject.data) {
                highResSrc = parentObject.data;
            }

            // Look for Facebook's high-resolution image serving patterns (highly specific, might break)
            // Example: theater mode images often have complex parent structures with links
            let parentLink = img.closest('a[ajaxify*="viewer"]'); // Common pattern for photo links
            if (parentLink && parentLink.href) {
                const urlParams = new URLSearchParams(new URL(parentLink.href).search);
                if (urlParams.get('src')) highResSrc = urlParams.get('src'); // Some share dialogs
            }

            // If part of a gallery, sometimes a sibling element or parent has the full-res link
            const galleryItem = img.closest('div[data-visualcompletion="photo-layout"] > div > div > a');
            if(galleryItem && galleryItem.href && galleryItem.href.includes("photo.php")){
                // This link might itself need to be fetched to get the highest res, or might have info in URL
                // For now, we'll assume the `img.src` from such structures is what we can get.
            }

            // Try to find a higher-res version using attribute patterns
            if (img.dataset.src) highResSrc = img.dataset.src;
            if (img.getAttribute('data-full-src')) highResSrc = img.getAttribute('data-full-src');
            if (img.getAttribute('data-orig-src')) highResSrc = img.getAttribute('data-orig-src');

            // Process image URL to get highest resolution variant
            // Replace Facebook's image downsizing parameters
            src = src.replace(/\/[sp]\d+x\d+\//, '/');
            src = src.replace(/_\d+x\d+/, '');

            src = highResSrc || src; // Prioritize high-res if found

            let photoId = `photo_${Date.now()}_${index}`;
            // Attempt to find an ID from a parent link or data attribute
            if (parentLink && parentLink.href) {
                const photoIdMatch = parentLink.href.match(/fbid=([\w.-]+)/) ||
                    parentLink.href.match(/photos\/(?:a\.\d+\/)?([\w.-]+)/) ||
                    parentLink.href.match(/set=pb\.([\w.-]+)/); // For profile pictures in sets
                if (photoIdMatch && photoIdMatch[1]) {
                    photoId = photoIdMatch[1];
                }
            }
            // Try data-ft attribute if present (older Facebook)
            const dataFt = img.closest('[data-ft]');
            if (dataFt && dataFt.dataset.ft) {
                try {
                    const ft = JSON.parse(dataFt.dataset.ft);
                    if (ft.photo_id) photoId = ft.photo_id;
                } catch (e) { /* ignore parsing error */ }
            }

            // Try to use the image's ID attribute
            if (img.id && img.id.includes('photo_')) {
                photoId = img.id;
            }

            const altText = img.alt || '';
            const originalName = altText.substring(0, 80).replace(/[^a-zA-Z0-9_.\-]/g, '_').replace(/_+/g, '_') || `${photoId}.jpg`;

            console.log(`Found photo: id=${photoId}, src=${src.substring(0, 100)}...`);
            return { id: photoId, url: src, originalName: originalName };
        }).filter(p => p.url && !p.url.startsWith('data:image') && p.url.includes('fbcdn.net'));
        // Only include Facebook CDN images, exclude base64 or non-FB images

        // Deduplicate based on URL or ID if possible (some images might appear multiple times in DOM)
        const uniquePhotos = [];
        const seen = new Set();
        for (const photo of photoData) {
            const key = photo.id && photo.id !== photo.originalName ? photo.id : photo.url; // Prioritize ID if it's not generic
            if (!seen.has(key)) {
                uniquePhotos.push(photo);
                seen.add(key);
            }
        }

        console.log(`After deduplication: ${uniquePhotos.length} unique photos`);

        if (uniquePhotos.length > 0) {
            let postId = null;
            const storyIdMatch = url.match(/story_fbid=([\w.-]+)/) ||
                url.match(/\/posts\/([\w.-]+)/) ||
                url.match(/fbid=([\w.-]+)/);
            if (storyIdMatch && storyIdMatch[1]) {
                postId = storyIdMatch[1];
            } else {
                postId = `collection_${Date.now()}`; // Fallback for general photo collections
            }

            if (uniquePhotos.length === 1 && (url.includes("photo.php") || url.includes("/photos/"))) {
                // It's likely a single photo page if only one large image is prominently displayed
                // and the URL structure matches a photo permalink.
                // Check if it's NOT part of a set explicitly by looking for "set=a."
                if (!url.includes("set=a.")) {
                    console.log("Detected single photo page");
                    return { isSinglePhotoPage: true, photoUrl: uniquePhotos[0].url, photoId: uniquePhotos[0].id };
                }
            }

            // If multiple photos or single photo in a context that isn't strictly a single photo permalink.
            console.log(`Detected post with ${uniquePhotos.length} photos, postId=${postId}`);
            return { isPostWithPhotos: true, postId, photoIds: uniquePhotos };
        }
    }
    return null;
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "getPageContext") {
        console.log("Received getPageContext request from popup");

        // Prioritize album detection
        const albumInfo = getAlbumInfo();
        if (albumInfo && albumInfo.isAlbum && albumInfo.albumId) {
            console.log("Responding with album info", albumInfo);
            sendResponse(albumInfo);
            return true; // Keep message channel open for async response if needed
        }

        // Then check for posts or general photo collections
        const postOrCollectionInfo = getPostOrCollectionInfo();
        if (postOrCollectionInfo) {
            console.log("Responding with post/collection info", postOrCollectionInfo);
            sendResponse(postOrCollectionInfo);
            return true;
        }

        // If none of the above, it's not a recognized downloadable page
        console.log("No downloadable content detected");
        sendResponse({ isAlbum: false, isPostWithPhotos: false, isSinglePhotoPage: false });
        return true;
    }
});

// Log on initial load to confirm script is running
console.log("Facebook Photo Downloader content script initialized, analyzing page...");
// Optional: Run detection on load to log debug info
setTimeout(() => {
    const albumInfo = getAlbumInfo();
    const postInfo = getPostOrCollectionInfo();
    console.log("Initial page analysis:", {albumInfo, postInfo});
}, 1000);