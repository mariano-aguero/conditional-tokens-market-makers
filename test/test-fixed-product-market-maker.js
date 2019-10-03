require('openzeppelin-test-helpers')
const { getConditionId, getCollectionId, getPositionId } = require('@gnosis.pm/conditional-tokens-contracts/test/utils')
const { randomHex, toBN } = web3.utils

const ConditionalTokens = artifacts.require('ConditionalTokens')
const WETH9 = artifacts.require('WETH9')
const FixedProductMarketMaker = artifacts.require('FixedProductMarketMaker')

contract('FixedProductMarketMaker', function([, oracle, investor1, trader, investor2]) {
    const questionId = randomHex(32)
    const numOutcomes = 4
    const conditionId = getConditionId(oracle, questionId, numOutcomes)
    const collectionIds = Array.from(
        { length: numOutcomes },
        (_, i) => getCollectionId(conditionId, toBN(1).shln(i))
    );

    let conditionalTokens
    let collateralToken
    let positionIds
    before(async function() {
        conditionalTokens = await ConditionalTokens.deployed();
        collateralToken = await WETH9.deployed();
        positionIds = collectionIds.map(collectionId => getPositionId(collateralToken.address, collectionId))
    })

    let fixedProductMarketMaker;
    const feeFactor = toBN(3e15) // (0.3%)
    step('can be created', async function() {
        await conditionalTokens.prepareCondition(oracle, questionId, numOutcomes);
        fixedProductMarketMaker = await FixedProductMarketMaker.new(conditionalTokens.address, collateralToken.address, [conditionId], feeFactor);
    })

    const addedFunds1 = toBN(10e18)
    const initialDistribution = [1, 2, 1, 1]
    const expectedFundedAmounts = [toBN(5e18), toBN(10e18), toBN(5e18), toBN(5e18)]
    step('can be funded', async function() {
        await collateralToken.deposit({ value: addedFunds1, from: investor1 });
        await collateralToken.approve(fixedProductMarketMaker.address, addedFunds1, { from: investor1 });
        await fixedProductMarketMaker.addFunding(addedFunds1, initialDistribution, { from: investor1 });

        (await collateralToken.balanceOf(investor1)).should.be.a.bignumber.equal("0");
        (await fixedProductMarketMaker.balanceOf(investor1)).should.be.a.bignumber.equal(addedFunds1);

        for(let i = 0; i < positionIds.length; i++) {
            (await conditionalTokens.balanceOf(fixedProductMarketMaker.address, positionIds[i]))
                .should.be.a.bignumber.equal(expectedFundedAmounts[i]);
            (await conditionalTokens.balanceOf(investor1, positionIds[i]))
                .should.be.a.bignumber.equal(addedFunds1.sub(expectedFundedAmounts[i]));
        }
    });

    let marketMakerPool;
    step('can buy tokens from it', async function() {
        const investmentAmount = toBN(1e18)
        const buyOutcomeIndex = 1;
        await collateralToken.deposit({ value: investmentAmount, from: trader });
        await collateralToken.approve(fixedProductMarketMaker.address, investmentAmount, { from: trader });

        const outcomeTokensToBuy = await fixedProductMarketMaker.calcBuyAmount(investmentAmount, buyOutcomeIndex);

        await fixedProductMarketMaker.buy(investmentAmount, buyOutcomeIndex, outcomeTokensToBuy, { from: trader });

        (await collateralToken.balanceOf(trader)).should.be.a.bignumber.equal("0");
        (await fixedProductMarketMaker.balanceOf(trader)).should.be.a.bignumber.equal("0");

        marketMakerPool = []
        for(let i = 0; i < positionIds.length; i++) {
            let newMarketMakerBalance;
            if(i === buyOutcomeIndex) {
                newMarketMakerBalance = expectedFundedAmounts[i].add(investmentAmount).sub(outcomeTokensToBuy);
                (await conditionalTokens.balanceOf(trader, positionIds[i]))
                    .should.be.a.bignumber.equal(outcomeTokensToBuy);
            } else {
                newMarketMakerBalance = expectedFundedAmounts[i].add(investmentAmount);
                (await conditionalTokens.balanceOf(trader, positionIds[i]))
                    .should.be.a.bignumber.equal("0");
            }
            (await conditionalTokens.balanceOf(fixedProductMarketMaker.address, positionIds[i]))
                .should.be.a.bignumber.equal(newMarketMakerBalance);
            marketMakerPool[i] = newMarketMakerBalance
        }
    })

    step('can sell tokens to it', async function() {
        const returnAmount = toBN(5e17)
        const sellOutcomeIndex = 1;
        await conditionalTokens.setApprovalForAll(fixedProductMarketMaker.address, true, { from: trader });

        const outcomeTokensToSell = await fixedProductMarketMaker.calcSellAmount(returnAmount, sellOutcomeIndex);

        await fixedProductMarketMaker.sell(returnAmount, sellOutcomeIndex, outcomeTokensToSell, { from: trader });

        (await collateralToken.balanceOf(trader)).should.be.a.bignumber.equal(returnAmount);
        (await fixedProductMarketMaker.balanceOf(trader)).should.be.a.bignumber.equal("0");

        for(let i = 0; i < positionIds.length; i++) {
            let newMarketMakerBalance;
            if(i === sellOutcomeIndex) {
                newMarketMakerBalance = marketMakerPool[i].sub(returnAmount).add(outcomeTokensToSell)
            } else {
                newMarketMakerBalance = marketMakerPool[i].sub(returnAmount)
            }
            (await conditionalTokens.balanceOf(fixedProductMarketMaker.address, positionIds[i]))
                .should.be.a.bignumber.equal(newMarketMakerBalance);
            marketMakerPool[i] = newMarketMakerBalance
        }
    })

    const addedFunds2 = toBN(5e18)
    step('can continue being funded', async function() {
        await collateralToken.deposit({ value: addedFunds2, from: investor2 });
        await collateralToken.approve(fixedProductMarketMaker.address, addedFunds2, { from: investor2 });
        await fixedProductMarketMaker.addFunding(addedFunds2, [], { from: investor2 });

        (await collateralToken.balanceOf(investor2)).should.be.a.bignumber.equal("0");
        (await fixedProductMarketMaker.balanceOf(investor2)).should.be.a.bignumber.gt("0");

        for(let i = 0; i < positionIds.length; i++) {
            let newMarketMakerBalance = await conditionalTokens.balanceOf(fixedProductMarketMaker.address, positionIds[i])
            newMarketMakerBalance.should.be.a.bignumber.gt(marketMakerPool[i]).lte(marketMakerPool[i].add(addedFunds2));
            marketMakerPool[i] = newMarketMakerBalance;

            (await conditionalTokens.balanceOf(investor2, positionIds[i]))
                .should.be.a.bignumber.gte("0").lt(addedFunds2);
        }
    });

    const burnedShares1 = toBN(5e18)
    step('can be defunded', async function() {
        await fixedProductMarketMaker.removeFunding(burnedShares1, { from: investor1 });

        (await collateralToken.balanceOf(investor1)).should.be.a.bignumber.equal("0");
        (await fixedProductMarketMaker.balanceOf(investor1)).should.be.a.bignumber.equal(addedFunds1.sub(burnedShares1));

        for(let i = 0; i < positionIds.length; i++) {
            let newMarketMakerBalance = await conditionalTokens.balanceOf(fixedProductMarketMaker.address, positionIds[i])
            newMarketMakerBalance.should.be.a.bignumber.lt(marketMakerPool[i]);
            (await conditionalTokens.balanceOf(investor1, positionIds[i]))
                .should.be.a.bignumber.equal(
                    addedFunds1
                        .sub(expectedFundedAmounts[i])
                        .add(marketMakerPool[i])
                        .sub(newMarketMakerBalance)
                );

            marketMakerPool[i] = newMarketMakerBalance;
        }
    })
})
