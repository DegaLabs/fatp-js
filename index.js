const CaspSDK = require("casper-js-sdk")
const { RequestManager, HTTPTransport, Client } = require("@open-rpc/client-js")
const {
    CLValue,
    CLPublicKey,
    CLKey,
    CLMap,
    RuntimeArgs,
    CasperClient,
    Contracts,
    Keys,
    CLKeyParameters,
    CLValueBuilder,
    CLValueParsers,
    CLResultBytesParser,
    CLU256BytesParser,
    CLU64BytesParser,
    CLU256Type,
    CLTypeTag
} = CaspSDK
const {
    utils,
    helpers,
    CasperContractClient,
} = require("casper-js-client-helper");
const { ERC20Client } = require('casper-erc20-js-client')
const axios = require('axios')
const BN = require('bignumber.js')
const { setClient, contractSimpleGetter, createRecipientAddress } = helpers;

const sleep = (ms) => {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

const A_PRECISION = 100
const MAX_LOOP_LIMIT = 256
const FEE_DENOMINATOR = 10000000000
const POOL_PRECISION_DECIMALS = 18
const FATP = class {
    constructor(

    ) { }

    static async createInstance(contractHash, nodeAddress, networkName) {
        const instance = new FATP()
        instance.contractHash = contractHash
        instance.nodeAddress = nodeAddress;
        instance.chainName = networkName;
        instance.contractClient = new CasperContractClient(nodeAddress, networkName);
        instance.namedKeysList = [
            "contract_owner",
            "contract_package_hash",
            "swap_storage",
            "token_indexes"
        ];
        const { contractPackageHash, namedKeys } = await setClient(
            instance.nodeAddress,
            instance.contractHash,
            instance.namedKeysList
        );

        instance.contractPackageHash = contractPackageHash;
        instance.contractClient.chainName = instance.chainName
        instance.contractClient.contractHash = instance.contractHash
        instance.contractClient.contractPackageHash = instance.contractPackageHash
        instance.contractClient.nodeAddress = instance.nodeAddress
        instance.namedKeys = namedKeys;

        return instance
    }

    parseKeyList(remainder) {
        let ret = new CaspSDK.CLU32BytesParser().fromBytesWithRemainder(remainder)
        let len = ret.result.val.value().toNumber()
        const keyList = []
        for (var i = 0; i < len; i++) {
            ret = new CaspSDK.CLKeyBytesParser().fromBytesWithRemainder(ret.remainder)
            keyList.push(Buffer.from(ret.result.val.value().data).toString("hex"))
        }
        return { keys: keyList, ret }
    }

    parseU256List(remainder) {
        let ret = new CaspSDK.CLU32BytesParser().fromBytesWithRemainder(remainder)
        let len = ret.result.val.value().toNumber()
        const u256List = []
        for (var i = 0; i < len; i++) {
            ret = new CaspSDK.CLU256BytesParser().fromBytesWithRemainder(ret.remainder)
            u256List.push(ret.result.val.value().toString())
        }
        return { u256s: u256List, ret }
    }

    async swapStorage() {
        const stateRootHash = await utils.getStateRootHash(this.nodeAddress);
        const transport = new HTTPTransport(this.nodeAddress);
        const client = new Client(new RequestManager([transport]));

        const res = await client.request({
            method: 'state_get_item',
            params: {
                state_root_hash: stateRootHash,
                key: "hash-" + this.contractHash,
                path: ['swap_storage']
            }
        });
        let storedValueJson;
        if (res.error) {
            throw new Error("Cannot read swap storage")
        } else {
            storedValueJson = res.stored_value;
        }

        const swapStorageBytes = Uint8Array.from(Buffer.from(storedValueJson.CLValue.bytes, 'hex'))

        // deserialize
        let ret = new CLU256BytesParser().fromBytesWithRemainder(swapStorageBytes)
        let initialA = ret.result.val.value().toString()

        ret = new CLU256BytesParser().fromBytesWithRemainder(ret.remainder)
        let futureA = ret.result.val.value().toString()

        ret = new CLU64BytesParser().fromBytesWithRemainder(ret.remainder)
        let initialATime = ret.result.val.value().toString()

        ret = new CLU64BytesParser().fromBytesWithRemainder(ret.remainder)
        let futurelATime = ret.result.val.value().toString()

        ret = new CLU64BytesParser().fromBytesWithRemainder(ret.remainder)
        let swapFee = ret.result.val.value().toString()

        ret = new CLU64BytesParser().fromBytesWithRemainder(ret.remainder)
        let adminFee = ret.result.val.value().toString()

        ret = new CaspSDK.CLKeyBytesParser().fromBytesWithRemainder(ret.remainder)
        let lpToken = Buffer.from(ret.result.val.value().data).toString("hex")

        const erc20 = new ERC20Client(
            this.nodeAddress, // RPC address
            this.chainName, // Network name
            ''
        );
        await erc20.setContractHash(lpToken)
        lpToken = erc20
        const { keys: pooledTokens, ret: r } = this.parseKeyList(ret.remainder)
        ret = r

        const { u256s: multipliers, ret: r1 } = this.parseU256List(ret.remainder)
        ret = r1

        const { u256s: balances, ret: r2 } = this.parseU256List(ret.remainder)
        ret = r2
        const swap = {
            initialA, futureA, initialATime, futurelATime, swapFee, adminFee, lpToken, pooledTokens, multipliers, balances
        }

        return swap
    }

    muldiv(a, b, c) {
        return new BN(a).multipliedBy(b).dividedBy(c)
    }

    getD(xp, a) {
        let numToken = xp.length
        let s = new BN(0)
        for (var i = 0; i < numToken; i++) {
            s = s.plus(xp[i])
        }

        if (s.comparedTo(0) == 0) {
            return '0'
        }

        let prevD
        let d = s
        let na = new BN(a).multipliedBy(numToken)

        for (var i = 0; i < MAX_LOOP_LIMIT; i++) {
            let dp = new BN(d)
            for (var j = 0; j < numToken; j++) {
                dp = this.muldiv(dp, d, new BN(xp[j]).multipliedBy(numToken))
            }

            prevD = d
            d = this.muldiv(
                this.muldiv(na, s, A_PRECISION).plus(dp.multipliedBy(numToken)),
                d,
                this.muldiv(
                    na.minus(A_PRECISION),
                    d,
                    A_PRECISION
                ).plus(dp.multipliedBy(numToken + 1))
            )

            if (this.within1(d, prevD)) {
                return d
            }
        }

        throw new Error("DNotConverge")
    }

    getY(preciseA, from, to, x, xp) {
        const numToken = xp.length

        let d = this.getD(xp, preciseA)

        let c = d
        let s = new BN(0)
        let na = new BN(preciseA).multipliedBy(numToken)
        let _x;
        for (var i = 0; i < numToken; i++) {
            if (i == from) {
                _x = x
            } else if (i == to) {
                _x = xp[i]
            } else {
                continue
            }

            s = s.plus(_x)
            c = this.muldiv(c, d, new BN(_x).multipliedBy(numToken))
        }

        c = this.muldiv(c, new BN(d).multipliedBy(A_PRECISION), na.multipliedBy(numToken))
        let b = s.plus(this.muldiv(d, A_PRECISION, na))
        let yPrev;
        let y = d

        for (var i = 0; i < MAX_LOOP_LIMIT; i++) {
            yPrev = y
            y = (new BN(y).multipliedBy(y).plus(c)).dividedBy(new BN(y).multipliedBy(2).plus(b).minus(d))

            if (this.within1(y, yPrev)) {
                return y.toFixed(0)
            }
        }
        throw new Error("ApproximationNotConverge")
    }

    getYd(a, tokenIndex, xp, d) {
        const numToken = xp.length

        let c = d
        let s = new BN(0)
        let na = new BN(a).multipliedBy(numToken)

        for (var i = 0; i < numToken; i++) {
            if (i != tokenIndex) {
                s = s.plus(xp[i])
                c = this.muldiv(c, d, new BN(xp[i]).multipliedBy(numToken))
            }
        }

        c = this.muldiv(c, new BN(d).multipliedBy(A_PRECISION), na.multipliedBy(numToken))
        let b = s.plus(this.muldiv(d, A_PRECISION, na))
        let yPrev;
        let y = d

        for (var i = 0; i < MAX; i++) {
            yPrev = y
            y = (new BN(y).multipliedBy(y).plus(c)).dividedBy(new BN(y).multipliedBy(2).plus(b).minus(d))

            if (this.within1(y, yPrev)) {
                return y.toFixed(0)
            }
        }
        throw new Error("ApproximationNotConverge")
    }

    _xp2(swap) {
        return this._xp(swap.balances, swap.multipliers)
    }

    _xp(balances, multipliers) {
        const ret = []
        for (var i = 0; i < balances.length; i++) {
            ret.push(new BN(balances[i]).multipliedBy(multipliers[i]).toFixed(0))
        }
        return ret
    }

    async doSwap({
        publicKey, from, to, dx, minDy, deadline, paymentAmount = '16000000000', ttl = 1800000, gasPrice = 1
    }) {
        let runtimeArgs = {};
        runtimeArgs = RuntimeArgs.fromMap({
            token_index_from: CLValueBuilder.u64(from),
            token_index_to: CLValueBuilder.u64(to),
            dx: CLValueBuilder.u256(dx),
            min_dy: CLValueBuilder.u256(minDy),
            deadline: CLValueBuilder.u64(deadline)
        })

        const contractHashAsByteArray = utils.contractHashToByteArray(this.contractHash)

        const deploy = CaspSDK.DeployUtil.makeDeploy(
            new CaspSDK.DeployUtil.DeployParams(
                publicKey,
                this.chainName,
                gasPrice,
                ttl,
                [],
            ),
            CaspSDK.DeployUtil.ExecutableDeployItem.newStoredContractByHash(
                contractHashAsByteArray,
                "swap",
                runtimeArgs,
            ),
            CaspSDK.DeployUtil.standardPayment(paymentAmount),
        )
        return deploy
    }

    async addLiquidity({
        publicKey, amounts, minToMint, deadline, paymentAmount = '35000000000', ttl = 1800000, gasPrice = 1
    }) {
        let runtimeArgs = {};
        runtimeArgs = RuntimeArgs.fromMap({
            amounts: CLValueBuilder.list(amounts.map(e => CLValueBuilder.u256(e))),
            min_to_mint: CLValueBuilder.u256(minToMint),
            deadline: CLValueBuilder.u64(deadline)
        })

        const contractHashAsByteArray = utils.contractHashToByteArray(this.contractHash)

        const deploy = CaspSDK.DeployUtil.makeDeploy(
            new CaspSDK.DeployUtil.DeployParams(
                publicKey,
                this.chainName,
                gasPrice,
                ttl,
                [],
            ),
            CaspSDK.DeployUtil.ExecutableDeployItem.newStoredContractByHash(
                contractHashAsByteArray,
                "swap",
                runtimeArgs,
            ),
            CaspSDK.DeployUtil.standardPayment(paymentAmount),
        )
        return deploy
    }

    async getAdminBalance(swap, tokenIndex) {
        if (tokenIndex >= swap.pooledTokens.length) {
            throw new Error('TokenIndexOutOfRange')
        }

        const erc20 = new ERC20Client(this.nodeAddress, this.chainName)
        await erc20.setContractHash(swap.pooledTokens[tokenIndex])
        const packageHash = new CaspSDK.CLByteArray(Uint8Array.from(Buffer.from(this.contractPackageHash.substring("contract-package-wasm".length), 'hex')))
        const balance = await erc20.balanceOf(packageHash)
        console.log('paclkage', balance)
        return new BN(balance).minus(swap.balances[tokenIndex]).toFixed(0)
    }

    // calculateWithdrawOneTokenDy(swap, tokenIndex, amount, total_supply) {
    //     let xp = this._xp2(swap)

    //     if (tokenIndex >= xp.length) {
    //         throw new Error("TokenIndexOutOfRange")
    //     }

    //     const v = {
    //         d0: new BN(0),
    //         d1: new BN(0),
    //         newY: new BN(0),
    //         feePerToken: new BN(0),
    //         preciseA: new BN(0)
    //     }

    //     v.preciseA = this.getAPricise(swap)
    //     v.d0 = this.getD(xp, v.preciseA)
    //     v.d1 = v.d0.minus(this.muldiv(amount, v.d0, total_supply))

    //     if (new BN(am)) {
    //         throw new Error("TokenIndexOutOfRange")
    //     }
    // }

    // async calculateRemoveLiquidityOneToken(swap, amount, tokenIndex, lpTotalSupply) {
    //     let totalSupply = lpTotalSupply ? lpTotalSupply : (await swap.lpToken.totalSupply())
    //     const amounts = []
    //     for (var i = 0; i < swap.balances.length; i++) {
    //         amounts.push(new BN(swap.balances[i]).multipliedBy(amount).dividedBy(totalSupply).toFixed(0))
    //     }
    //     return amounts
    // }

    async calculateRemoveLiquidity(swap, amount, lpTotalSupply) {
        let totalSupply = lpTotalSupply ? lpTotalSupply : (await swap.lpToken.totalSupply()).toString()
        const amounts = []
        for (var i = 0; i < swap.balances.length; i++) {
            amounts.push(new BN(swap.balances[i]).multipliedBy(amount).dividedBy(totalSupply).toFixed(0))
        }
        return amounts
    }

    calculateSwap(swap, from, to, dx) {
        const multipliers = swap.multipliers
        const xp = this._xp(swap.balances, multipliers)

        const x = new BN(dx).multipliedBy(multipliers[from]).plus(xp[from])
        let y = this.getY(this.getAPricise(swap), from, to, x, xp)

        let dy = new BN(xp[to]).minus(y).minus(1)
        let dyFee = this.muldiv(dy, swap.swapFee, 10000000000)
        dy = dy.minus(dyFee).dividedBy(multipliers[to])

        return dy.toFixed(0)
    }

    async calculateLPTokenAmount(swap, amounts, deposit, lpTotalSupply) {
        let a = this.getAPricise(swap)
        let balances = swap.balances
        let multipliers = swap.multipliers

        let d0 = this.getD(this._xp(balances, multipliers), a)
        for (var i = 0; i < balances.length; i++) {
            if (deposit) {
                balances[i] = new BN(balances[i]).plus(amounts[i])
            } else {
                balances[i] = new BN(balances[i]).minus(amounts[i])
            }
        }

        let d1 = this.getD(this._xp(balances, multipliers), a)

        let totalSupply = lpTotalSupply ? lpTotalSupply : (await swap.lpToken.totalSupply()).toString()
        console.log('calculateLPTokenAmount', d0.toFixed(0), d1.toFixed(0), totalSupply)
        if (deposit) {
            return this.muldiv(new BN(d1).minus(d0), totalSupply, d0)
        } else {
            return this.muldiv(new BN(d0).minus(d1), totalSupply, d0)
        }
    }

    async getVirtualPrice(swap, lpTotalSupply) {
        let d = this.getD(this._xp2(swap), this.getAPricise(swap))
        let totalSupply = lpTotalSupply ? lpTotalSupply : (await swap.lpToken.totalSupply()).toString()
        if (new BN(totalSupply).comparedTo(0) > 0) {
            return this.muldiv(d, new BN(10).pow(POOL_PRECISION_DECIMALS), totalSupply).toFixed(0)
        }
        return '0'
    }

    getTokenBalance(swap, index) {
        return swap.balances[index]
    }

    getTokenIndex(swap, token) {
        return swap.pooledTokens.indexOf(token)
    }

    getToken(swap, index) {
        return swap.pooledTokens[index]
    }

    getA(swap) {
        return new BN(this.getAPricise(swap)).dividedBy(A_PRECISION).toString(0)
    }

    getAPricise(swap) {
        const currentTime = Math.floor(Date.now() / 1000)
        const t1 = swap.futurelATime
        const a1 = swap.futureA

        if (currentTime < t1) {
            const t0 = swap.initialATime
            const a0 = swap.initialA
            if (new BN(a1).comparedTo(a0) > 0) {
                return new BN(a0).plus(new BN(a1).minus(a0).multipliedBy(currentTime - t0).dividedBy(t1 - t0)).toFixed(0)
            } else {
                return new BN(a0).minus(new BN(a0).minus(a1).multipliedBy(currentTime - t0).dividedBy(t1 - t0)).toFixed(0)
            }
        }

        return a1
    }

    difference(a, b) {
        if (new BN(a).comparedTo(b) > 0) {
            return new BN(a).minus(b)
        }
        return new BN(b).minus(a)
    }

    within1(a, b) {
        return this.difference(a, b).comparedTo(1) <= 0
    }
}

module.exports = { FATP }