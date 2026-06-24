const lenful = require('../lenful');

describe('lenful response parser', () => {
    test('accepts Lenful success message with order number', () => {
        const parsed = lenful._private.parseResponseForLenful({
            message: 'Create order number 4094616499 success!',
        });

        expect(parsed.ok).toBe(true);
        expect(parsed.externalId).toBe('4094616499');
    });

    test('accepts Lenful boolean status success response', () => {
        const parsed = lenful._private.parseResponseForLenful({
            status: true,
            message: 'Create order number 4094616499 success!',
            data: { id: 'lenful-id', order_number: '4094616499' },
        });

        expect(parsed.ok).toBe(true);
        expect(parsed.externalId).toBe('4094616499');
    });
});
