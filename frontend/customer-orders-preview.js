
/* GasHub Order Preview
   Load BEFORE customer-orders.js.
   Test data stays in memory; real orders are not overwritten.
*/
(function () {
    "use strict";

    var params = new URLSearchParams(location.search);

    if (params.get("previewOrders") !== "1") return;

    function daysAgo(days) {
        var d = new Date();
        d.setDate(d.getDate() - days);
        return d.toISOString();
    }

    var samples = [
        {
            orderId: "GH-TEST-1001",
            status: "Delivered",
            createdAt: daysAgo(8),
            deliveredAt: daysAgo(8),
            updatedAt: daysAgo(8),
            dealer: {
                id: "TEST-D01",
                name: "GasHub Sample Dealer",
                location: "Nairobi",
                verified: true
            },
            items: [{
                id: "TEST-P13",
                name: "13kg LPG Gas Refill",
                details: "13kg cylinder refill",
                quantity: 1,
                price: 2500,
                points: 25
            }],
            productTotal: 2500,
            deliveryFee: 150,
            discount: 0,
            total: 2650,
            paymentMethod: "mpesa",
            paymentStatus: "paid",
            mpesaReceipt: "TEST123456",
            customerName: "Sample Customer",
            customerPhone: "0700000000",
            customerEmail: "sample@example.com",
            pointsAwarded: 25,
            deliveryOption: "delivery",
            county: "Nairobi",
            town: "Nairobi",
            deliveryAddress: "Sample delivery address",
            deliveryLandmark: "Near sample landmark",
            orderNotes: "DEMO ORDER — no real payment made."
        },
        {
            orderId: "GH-TEST-1002",
            status: "Out for delivery",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            etaMinutes: 45,
            dealer: {
                id: "TEST-D02",
                name: "GasHub Demo Dealer",
                location: "Rongai"
            },
            items: [{
                id: "TEST-P6",
                name: "6kg LPG Gas Refill",
                details: "6kg cylinder refill",
                quantity: 2,
                price: 1200,
                points: 24
            }],
            productTotal: 2400,
            deliveryFee: 100,
            total: 2500,
            paymentMethod: "mpesa",
            paymentStatus: "pending",
            customerName: "Sample Customer",
            customerPhone: "0700000000",
            pointsAwarded: 24,
            deliveryOption: "delivery",
            orderNotes: "DEMO ORDER — no real payment made."
        },
        {
            orderId: "GH-TEST-1003",
            status: "Pending",
            createdAt: new Date().toISOString(),
            dealer: {
                id: "TEST-D03",
                name: "GasHub Test Dealer",
                location: "Kajiado"
            },
            items: [{
                id: "TEST-P13B",
                name: "13kg LPG Gas Refill",
                details: "13kg cylinder refill",
                quantity: 1,
                price: 2500,
                points: 25
            }],
            productTotal: 2500,
            deliveryFee: 150,
            total: 2650,
            paymentMethod: "mpesa",
            paymentStatus: "pending",
            customerName: "Sample Customer",
            customerPhone: "0700000000",
            pointsAwarded: 25,
            deliveryOption: "delivery",
            orderNotes: "DEMO ORDER — no real payment made."
        }
    ];

    function getOrder(id) {
        if (id) {
            return samples.find(function (o) {
                return String(o.orderId) === String(id);
            }) || null;
        }

        return samples[0];
    }

    window.GasHubOrdersPreview = {
        enabled: true,
        getOrder: getOrder,
        getSamples: function () {
            return samples.slice();
        }
    };

    console.info("[GasHub] Preview mode enabled. Sample orders:", samples);
})();