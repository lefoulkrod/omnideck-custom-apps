#!/usr/bin/env python3
"""Generate the approved original NES-inspired Gunsmoke character sprites."""
from pathlib import Path
from PIL import Image

OUT = Path('/home/omnideck/apps/gunsmoke-showdown/web/assets/sprites/own')
T=(0,0,0,0); INK=(35,23,18,255); DARK=(54,31,23,255)
HAT=(133,77,33,255); HAT_HI=(201,137,57,255); SKIN=(237,177,119,255); SKIN_D=(168,91,56,255)
BLUE=(48,94,153,255); BLUE_D=(29,55,103,255); RED=(170,52,40,255); RED_D=(104,35,31,255)
GREEN=(47,116,77,255); GREEN_D=(28,72,55,255); BLACK=(28,27,29,255); BLACK_HI=(67,64,62,255)
ORANGE=(192,83,35,255); ORANGE_D=(112,45,29,255); PANTS=(112,67,39,255); PANTS_D=(67,42,29,255)
GOLD=(244,190,62,255); CREAM=(251,221,143,255); METAL=(157,161,146,255)

def grid(w=24,h=32): return [[T for _ in range(w)] for _ in range(h)]
def px(g,x,y,c):
    if 0 <= y < len(g) and 0 <= x < len(g[0]): g[y][x]=c
def box(g,x0,y0,x1,y1,c):
    for y in range(y0,y1+1):
        for x in range(x0,x1+1): px(g,x,y,c)
def outline(g):
    w,h=len(g[0]),len(g); marks=set()
    for y in range(h):
        for x in range(w):
            if g[y][x] != T:
                for dx,dy in ((-1,0),(1,0),(0,-1),(0,1)):
                    nx,ny=x+dx,y+dy
                    if 0<=nx<w and 0<=ny<h and g[ny][nx]==T: marks.add((nx,ny))
    for x,y in marks: g[y][x]=INK

def regular(kind, step=0, shooting=False, dead=False):
    g=grid()
    if dead:
        box(g,3,24,19,26,HAT); box(g,5,22,16,24,kind[0]); box(g,8,25,14,27,SKIN)
        box(g,4,27,19,29,kind[2]); box(g,3,29,7,30,DARK); box(g,16,29,20,30,DARK); outline(g); return g
    shirt,shade,pants,accessory=kind
    # Shared approved broad flat-brim cowboy hat.
    box(g,5,4,18,6,HAT); box(g,8,1,15,4,DARK); box(g,9,0,14,1,HAT); box(g,7,6,16,6,HAT_HI)
    box(g,9,7,15,11,SKIN); px(g,10,8,INK); px(g,14,8,INK)
    # Compact body and narrow neck.
    box(g,10,12,14,13,SKIN); box(g,6,13,18,21,shirt); box(g,6,14,8,21,shade); box(g,16,14,18,21,shade)
    # Character-specific approved clothing details.
    if accessory=='player':
        box(g,10,12,14,13,RED); px(g,12,14,RED)  # neck-only bandana
        # small star on right chest, left of the arm
        for x,y in ((14,15),(13,16),(14,16),(15,16),(14,17)): px(g,x,y,GOLD)
    elif accessory=='bandit1':
        box(g,10,12,14,13,RED); px(g,12,14,RED)
    elif accessory=='bandit2':
        # Over nose/lower face, leaving eyes visible; contrasting green shirt.
        box(g,9,10,15,12,RED); box(g,10,12,14,13,RED); px(g,12,14,RED); box(g,11,13,13,14,CREAM)
    elif accessory=='bandit3':
        box(g,10,12,14,13,RED); px(g,12,14,RED)
    elif accessory=='bandit4':
        box(g,5,16,19,18,ORANGE_D); box(g,7,18,8,21,ORANGE)
    # Belt, legs, and lowered arm.
    box(g,5,20,18,22,pants); box(g,11,20,12,21,GOLD)
    left,right=7+step,13-step
    box(g,left,22,left+2,28,pants); box(g,right,22,right+2,28,pants)
    box(g,left-1,28,left+3,30,DARK); box(g,right-1,28,right+3,30,DARK)
    if shooting:
        box(g,17,14,20,16,shirt); box(g,19,13,21,15,SKIN); box(g,20,12,23,13,METAL); box(g,22,13,23,15,DARK)
    else:
        box(g,17,15,19,19,shade); box(g,17,19,18,20,SKIN)
    box(g,5,15,7,19,shade)
    outline(g)
    # Preserve eyes and the tiny player badge after contouring.
    px(g,10,8,INK); px(g,14,8,INK)
    if accessory=='player':
        for x,y in ((14,15),(13,16),(14,16),(15,16),(14,17)): px(g,x,y,GOLD)
    return g

def boss(step=0, shooting=False, dead=False):
    w,h=28,36; g=grid(w,h)
    if dead:
        box(g,3,27,23,29,BLACK); box(g,6,25,20,27,BLACK); box(g,7,29,22,31,BLACK); box(g,4,31,9,33,DARK); box(g,18,31,24,33,DARK); outline(g); return g
    # Approved all-black/charcoal hat and duster. No brown or yellow on boss.
    box(g,4,5,23,7,BLACK); box(g,8,1,19,5,BLACK); box(g,10,0,17,2,BLACK); box(g,7,7,20,7,BLACK_HI)
    box(g,10,8,17,14,SKIN); px(g,11,10,INK); px(g,16,10,INK)
    box(g,6,15,21,25,BLACK); box(g,6,16,9,25,BLACK_HI); box(g,18,16,21,25,BLACK_HI)
    box(g,9,14,18,15,RED); box(g,12,16,15,19,RED_D); box(g,11,20,13,22,BLACK)
    box(g,7,24,20,26,PANTS); box(g,11,24,15,25,BLACK_HI)
    box(g,9,26,12,32,PANTS); box(g,16,26,19,32,PANTS); box(g,8,32,13,34,DARK); box(g,15,32,20,34,DARK)
    if shooting:
        box(g,20,17,23,19,BLACK); box(g,22,16,24,18,SKIN); box(g,23,15,26,16,METAL); box(g,25,16,26,18,DARK)
    else:
        box(g,4,17,7,23,BLACK_HI); box(g,20,17,23,23,BLACK_HI); box(g,3,22,7,24,SKIN_D); box(g,21,22,24,24,SKIN_D)
    outline(g); px(g,11,10,INK); px(g,16,10,INK); return g

def save(g,path):
 h,w=len(g),len(g[0]); im=Image.new('RGBA',(w,h),T); q=im.load()
 for y in range(h):
  for x in range(w): q[x,y]=g[y][x]
 im.save(path)
def frames(prefix, kind, is_boss=False):
 poses={'walk_0':0,'walk_1':1,'walk_2':0,'walk_3':-1,'idle':0}
 for name,step in poses.items(): save(boss(step=step) if is_boss else regular(kind,step=step),OUT/f'{prefix}_{name}.png')
 save(boss(shooting=True) if is_boss else regular(kind,shooting=True),OUT/f'{prefix}_shoot.png')
 save(boss(dead=True) if is_boss else regular(kind,dead=True),OUT/f'{prefix}_death.png')

def main():
    OUT.mkdir(parents=True,exist_ok=True)
    frames('player',(BLUE,BLUE_D,PANTS,'player'))
    frames('bandit1',(RED,RED_D,PANTS_D,'bandit1'))
    frames('bandit2',(GREEN,GREEN_D,PANTS_D,'bandit2'))
    frames('bandit3',(BLACK,BLACK_HI,PANTS_D,'bandit3'))
    frames('bandit4',(ORANGE,ORANGE_D,PANTS,'bandit4'))
    frames('boss',None,True)
    print(f'Generated {len(list(OUT.glob("*.png")))} sprites in {OUT}')
if __name__ == '__main__': main()
