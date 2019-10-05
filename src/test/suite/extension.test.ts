import { extensions } from 'vscode';

import * as assert from 'assert';

import { ExtensionId } from '../../constants';

suite("Extension Tests", function()
{
    suiteSetup(async function()
    { 
        let extension = extensions.getExtension(ExtensionId); 
        assert.ok(extension);
        if (extension && !extension.isActive)
        { 
            await extension.activate(); 
        }
    }); 

    test("Verify extension is active", function()
    {
        const extension = extensions.getExtension(ExtensionId);
        assert.ok(extension);
        if (extension)
        {
            assert.ok(extension.isActive);
        }
    });
});
