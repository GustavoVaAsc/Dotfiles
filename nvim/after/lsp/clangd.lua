-- clangd for competitive programming: use GCC's headers and flags.
--
-- Without a compile database clangd fakes a `clang` command and picks the
-- newest GCC install it finds, which may lack libstdc++ headers (so
-- <bits/stdc++.h> fails). Point it at the same GCC install g++ uses.
local fallback_flags = { "-std=c++17" }

if vim.fn.executable("g++") == 1 then
    local ok, gcc = pcall(function()
        return vim.system({ "g++", "-print-libgcc-file-name" }, { text = true }):wait(2000)
    end)
    if ok and gcc.code == 0 then
        local install_dir = vim.fs.dirname(vim.trim(gcc.stdout))
        table.insert(fallback_flags, "--gcc-install-dir=" .. install_dir)
    end
end

local query_drivers = { "/usr/bin/g++*", "/usr/bin/c++*" }
local gxx = vim.fn.exepath("g++")
if gxx ~= "" then
    local dir = vim.fs.dirname(gxx)
    if dir ~= "/usr/bin" then
        table.insert(query_drivers, dir .. "/g++*")
        table.insert(query_drivers, dir .. "/c++*")
    end
end

return {
    cmd = {
        "clangd",
        "--background-index",
        -- With a compile database that uses g++, take its includes/flags from it.
        "--query-driver=" .. table.concat(query_drivers, ","),
    },
    -- Narrowed to c/cpp on purpose (lspconfig also enables objc/cuda/proto).
    filetypes = { "c", "cpp" },
    init_options = {
        fallbackFlags = fallback_flags,
    },
}
