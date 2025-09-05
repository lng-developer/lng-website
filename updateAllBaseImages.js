/**
 * Script để sync base image từ ASIN-Listing matching
 * 
 * Usage:
 * node scripts/syncAsinListingBaseImage.js [options]
 * 
 * Options:
 * --dry-run: Chỉ hiển thị kết quả mà không thực sự cập nhật
 * --limit=100: Giới hạn số lượng order được xử lý (mặc định: không giới hạn)
 * --order-id=ORDER123: Chỉ xử lý order cụ thể
 * --missing-only: Chỉ xử lý items chưa có base image
 * --force: Ghi đè base image ngay cả khi đã có
 * --verbose: Hiển thị log chi tiết
 * 
 * Examples:
 * node scripts/syncAsinListingBaseImage.js --dry-run --verbose
 * node scripts/syncAsinListingBaseImage.js --limit=50 --missing-only
 * node scripts/syncAsinListingBaseImage.js --order-id=112-8234567-8901234 --force
 */

const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

// Import models
const db = require('./src/models');
const OrderCustomProduct = db.orderCustomProduct;
const Listing = db.listing;

// Parse command line arguments
const args = process.argv.slice(2);
const options = {
    dryRun: args.includes('--dry-run'),
    verbose: args.includes('--verbose'),
    missingOnly: args.includes('--missing-only'),
    force: args.includes('--force'),
    limit: null,
    orderId: null
};

// Parse limit option
const limitArg = args.find(arg => arg.startsWith('--limit='));
if (limitArg) {
    options.limit = parseInt(limitArg.split('=')[1]) || null;
}

// Parse order-id option
const orderIdArg = args.find(arg => arg.startsWith('--order-id='));
if (orderIdArg) {
    options.orderId = orderIdArg.split('=')[1];
}

// Logging utilities
const log = (message, level = 'info') => {
    const timestamp = new Date().toISOString();
    const prefix = level === 'error' ? '❌' : level === 'success' ? '✅' : level === 'warning' ? '⚠️' : 'ℹ️';
    console.log(`[${timestamp}] ${prefix} ${message}`);
};

const verbose = (message) => {
    if (options.verbose) {
        log(message, 'verbose');
    }
};

// Statistics tracking
const stats = {
    totalOrders: 0,
    totalItems: 0,
    itemsWithAsin: 0,
    asinMatches: 0,
    updatedItems: 0,
    skippedItems: 0,
    errors: 0,
    startTime: Date.now()
};

/**
 * Build ASIN to Listing mapping
 */
async function buildAsinListingMap(asins) {
    verbose(`Building ASIN-Listing mapping for ${asins.length} unique ASINs...`);

    const listings = await Listing.find({
        asin: { $in: asins },
        product_image: { $exists: true, $ne: '', $ne: null }
    }).select('asin product_image').lean();

    const map = new Map();
    for (const listing of listings) {
        if (listing.asin && listing.product_image) {
            map.set(listing.asin, listing.product_image);
        }
    }

    verbose(`Found ${map.size} ASIN-Listing matches`);
    return map;
}

/**
 * Get orders to process based on options
 */
async function getOrdersToProcess() {
    verbose('Fetching orders to process...');

    let query = {};

    // Filter by specific order ID if provided
    if (options.orderId) {
        query.orderId = options.orderId;
    }

    // Build aggregation pipeline
    let pipeline = [
        { $match: query },
        {
            $lookup: {
                from: 'listings',
                let: { itemAsins: '$items.asin' },
                pipeline: [
                    {
                        $match: {
                            $expr: {
                                $and: [
                                    { $in: ['$asin', '$$itemAsins'] },
                                    { $ne: ['$product_image', null] },
                                    { $ne: ['$product_image', ''] }
                                ]
                            }
                        }
                    },
                    { $project: { asin: 1, product_image: 1 } }
                ],
                as: 'matchedListings'
            }
        },
        // Only include orders that have at least one item with ASIN that matches listings
        { $match: { 'matchedListings.0': { $exists: true } } },
        { $sort: { createdAt: -1 } }
    ];

    // Apply limit if specified
    if (options.limit) {
        pipeline.push({ $limit: options.limit });
    }

    const orders = await OrderCustomProduct.aggregate(pipeline);
    verbose(`Found ${orders.length} orders to process`);

    return orders;
}

/**
 * Process a single order
 */
async function processOrder(order) {
    verbose(`Processing order: ${order.orderId}`);
    stats.totalOrders++;

    const results = {
        orderId: order.orderId,
        totalItems: order.items?.length || 0,
        processedItems: [],
        errors: []
    };

    // Build ASIN map for this order
    const asinsInOrder = order.items
        ?.map(item => item.asin)
        .filter(asin => asin && asin.trim())
        .map(asin => asin.trim()) || [];

    if (asinsInOrder.length === 0) {
        verbose(`Order ${order.orderId} has no items with ASIN, skipping`);
        return results;
    }

    const asinToListingMap = await buildAsinListingMap([...new Set(asinsInOrder)]);

    // Process each item
    let orderUpdated = false;

    for (let i = 0; i < (order.items?.length || 0); i++) {
        const item = order.items[i];
        stats.totalItems++;

        const itemResult = {
            orderItemId: item.orderItemId || `item-${i}`,
            asin: item.asin || null,
            action: 'skipped',
            reason: '',
            oldBaseImage: item.baseImage?.imageUrl || null,
            newBaseImage: null
        };

        try {
            // Skip if no ASIN
            if (!item.asin?.trim()) {
                itemResult.reason = 'no ASIN';
                stats.skippedItems++;
                results.processedItems.push(itemResult);
                continue;
            }

            stats.itemsWithAsin++;
            const asin = item.asin.trim();

            // Check if ASIN has matching listing
            if (!asinToListingMap.has(asin)) {
                itemResult.reason = 'no matching listing';
                stats.skippedItems++;
                results.processedItems.push(itemResult);
                continue;
            }

            stats.asinMatches++;
            const listingImage = asinToListingMap.get(asin);

            // Check current base image status
            const hasBaseImage = item.baseImage?.imageUrl && item.baseImage.imageUrl.trim();

            if (hasBaseImage && !options.force) {
                if (options.missingOnly) {
                    itemResult.reason = 'already has base image (missing-only mode)';
                    stats.skippedItems++;
                    results.processedItems.push(itemResult);
                    continue;
                } else {
                    // Check if it's the same image
                    if (item.baseImage.imageUrl === listingImage) {
                        itemResult.reason = 'same image already set';
                        stats.skippedItems++;
                        results.processedItems.push(itemResult);
                        continue;
                    }
                }
            }

            // Update base image
            if (!options.dryRun) {
                if (!item.baseImage) {
                    item.baseImage = {};
                }
                item.baseImage.imageUrl = listingImage;
                // Keep existing width/height if any
                orderUpdated = true;
            }

            itemResult.action = options.dryRun ? 'would-update' : 'updated';
            itemResult.newBaseImage = listingImage;
            itemResult.reason = hasBaseImage ? 'base image replaced' : 'base image set';
            stats.updatedItems++;

            results.processedItems.push(itemResult);

        } catch (error) {
            itemResult.action = 'error';
            itemResult.reason = error.message;
            stats.errors++;
            results.errors.push({
                itemId: itemResult.orderItemId,
                error: error.message
            });
            results.processedItems.push(itemResult);
        }
    }

    // Save order if updated and not dry run
    if (orderUpdated && !options.dryRun) {
        try {
            const orderDoc = await OrderCustomProduct.findOne({ orderId: order.orderId });
            if (orderDoc) {
                // Update the actual order document
                for (let i = 0; i < orderDoc.items.length; i++) {
                    const docItem = orderDoc.items[i];
                    const processedItem = order.items.find(item =>
                        item.orderItemId === docItem.orderItemId
                    );
                    if (processedItem && processedItem.baseImage?.imageUrl) {
                        if (!docItem.baseImage) {
                            docItem.baseImage = {};
                        }
                        docItem.baseImage.imageUrl = processedItem.baseImage.imageUrl;
                    }
                }
                await orderDoc.save();
                verbose(`Order ${order.orderId} saved successfully`);
            }
        } catch (error) {
            log(`Error saving order ${order.orderId}: ${error.message}`, 'error');
            results.errors.push({
                type: 'save_error',
                error: error.message
            });
            stats.errors++;
        }
    }

    return results;
}

/**
 * Print final statistics
 */
function printStats() {
    const duration = Math.round((Date.now() - stats.startTime) / 1000);

    console.log('\n' + '='.repeat(60));
    log('SYNC COMPLETED', 'success');
    console.log('='.repeat(60));

    console.log(`📊 Statistics:`);
    console.log(`   • Total Orders Processed: ${stats.totalOrders}`);
    console.log(`   • Total Items Processed: ${stats.totalItems}`);
    console.log(`   • Items with ASIN: ${stats.itemsWithAsin}`);
    console.log(`   • ASIN-Listing Matches: ${stats.asinMatches}`);
    console.log(`   • Items Updated: ${stats.updatedItems}`);
    console.log(`   • Items Skipped: ${stats.skippedItems}`);
    console.log(`   • Errors: ${stats.errors}`);
    console.log(`   • Duration: ${duration}s`);
    console.log(`   • Mode: ${options.dryRun ? 'DRY RUN' : 'LIVE UPDATE'}`);

    if (options.dryRun && stats.updatedItems > 0) {
        console.log(`\n💡 Run without --dry-run to apply ${stats.updatedItems} updates`);
    }
}

/**
 * Main execution function
 */
async function main() {
    try {
        // Connect to database
        await mongoose.connect('mongodb+srv://lngdeveloperworkspace:lannhi123@lngweb.l3xatze.mongodb.net/lng_db?retryWrites=true&w=majority&appName=LNGWeb', {
            useNewUrlParser: true,
            useUnifiedTopology: true,
        });
        log('Connected to MongoDB', 'success');

        // Print configuration
        console.log('🚀 ASIN-Listing Base Image Sync');
        console.log('='.repeat(40));
        console.log(`Configuration:`);
        console.log(`   • Dry Run: ${options.dryRun ? 'Yes' : 'No'}`);
        console.log(`   • Missing Only: ${options.missingOnly ? 'Yes' : 'No'}`);
        console.log(`   • Force Update: ${options.force ? 'Yes' : 'No'}`);
        console.log(`   • Limit: ${options.limit || 'No limit'}`);
        console.log(`   • Order ID: ${options.orderId || 'All orders'}`);
        console.log(`   • Verbose: ${options.verbose ? 'Yes' : 'No'}`);
        console.log('');

        // Get and process orders
        const orders = await getOrdersToProcess();

        if (orders.length === 0) {
            log('No orders found to process', 'warning');

            // If specific order ID was provided, do additional debugging
            if (options.orderId) {
                log(`Debugging order ${options.orderId}...`, 'info');

                // Check if order exists at all
                const orderExists = await OrderCustomProduct.findOne({ orderId: options.orderId }).lean();
                if (!orderExists) {
                    log(`Order ${options.orderId} not found in database`, 'error');
                } else {
                    log(`Order ${options.orderId} exists but no ASIN-Listing matches found`, 'warning');

                    const itemsWithAsin = orderExists.items?.filter(item => item.asin?.trim()) || [];
                    log(`Order has ${orderExists.items?.length || 0} items, ${itemsWithAsin.length} with ASIN`);

                    if (itemsWithAsin.length > 0) {
                        const asins = itemsWithAsin.map(item => item.asin.trim());
                        const uniqueAsins = [...new Set(asins)];

                        const matchingListings = await Listing.find({
                            asin: { $in: uniqueAsins },
                            product_image: { $exists: true, $ne: '', $ne: null }
                        }).lean();

                        log(`Found ${matchingListings.length} listings with images for ASINs: ${uniqueAsins.join(', ')}`);

                        if (matchingListings.length === 0) {
                            log('Suggestions:', 'info');
                            log('• Check if listings exist for these ASINs', 'info');
                            log('• Verify listings have product_image field populated', 'info');
                        }
                    }
                }
            }

            return;
        }

        log(`Starting processing of ${orders.length} orders...`);

        // Process orders
        const allResults = [];
        for (const order of orders) {
            const result = await processOrder(order);
            allResults.push(result);

            if (result.processedItems.length > 0) {
                const updatedCount = result.processedItems.filter(item =>
                    item.action === 'updated' || item.action === 'would-update'
                ).length;

                if (updatedCount > 0 || options.verbose) {
                    log(`Order ${result.orderId}: ${updatedCount}/${result.totalItems} items processed`);
                }

                if (options.verbose) {
                    result.processedItems.forEach(item => {
                        if (item.action === 'updated' || item.action === 'would-update') {
                            console.log(`     • ${item.orderItemId}: ${item.reason}`);
                        }
                    });
                }
            }
        }

        // Print results
        printStats();

        if (options.verbose && allResults.some(r => r.errors.length > 0)) {
            console.log('\n❌ Errors encountered:');
            allResults.forEach(result => {
                if (result.errors.length > 0) {
                    console.log(`   Order ${result.orderId}:`);
                    result.errors.forEach(error => {
                        console.log(`     • ${error.itemId || 'Order'}: ${error.error}`);
                    });
                }
            });
        }

    } catch (error) {
        log(`Script failed: ${error.message}`, 'error');
        if (options.verbose) {
            console.error(error.stack);
        }
        process.exit(1);
    } finally {
        await mongoose.disconnect();
        log('Disconnected from MongoDB');
    }
}

// Handle script interruption
process.on('SIGINT', async () => {
    log('Script interrupted by user', 'warning');
    await mongoose.disconnect();
    process.exit(0);
});

// Run the script
main().catch(error => {
    console.error('Unhandled error:', error);
    process.exit(1);
});